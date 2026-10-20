const { query, getClient } = require('../config/db');
const { setFlash } = require('../middleware/flash');
const { toCsv } = require('../utils/helpers');

const SIZE_PATTERN = /^[A-Z0-9][A-Z0-9 ./-]{0,7}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_OPTIONS = 40;
const IMAGE_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

// The side panel posts JSON and expects JSON back; a plain form post (no JS)
// gets a flash message and a redirect instead.
function wantsJson(req) {
  return req.is('application/json') || (req.get('accept') || '').includes('application/json');
}

function fail(req, res, status, message, field) {
  if (wantsJson(req)) return res.status(status).json({ error: message, field });
  setFlash(req, 'error', message);
  return res.redirect('/admin/products');
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(/[\s,|]+/).filter(Boolean);
}

function money(value) {
  const n = Number(String(value === undefined ? '' : value).replace(/[₱,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function normalizeSize(value) {
  const s = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return SIZE_PATTERN.test(s) ? s : null;
}

function normalizeColor(value) {
  const c = String(value || '').trim().toLowerCase();
  return COLOR_PATTERN.test(c) ? c : null;
}

function wholeNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

// Validates and normalizes product fields from the form, JSON or a CSV row.
function readProduct(body) {
  const p = {
    name: String(body.name || '').trim().slice(0, 120),
    barcode: String(body.barcode || '').trim().slice(0, 60) || null,
    category_id: /^\d+$/.test(String(body.category_id || '')) ? Number(body.category_id) : null,
    // Form posts send each size separately, so only CSV text needs splitting.
    sizes: [...new Set((Array.isArray(body.sizes) ? body.sizes : list(body.sizes)).map(normalizeSize).filter(Boolean))].slice(0, 20),
    colors: [...new Set(list(body.colors).map(normalizeColor).filter(Boolean))].slice(0, 12),
    cost_price: money(body.cost_price === '' || body.cost_price === undefined ? 0 : body.cost_price),
    selling_price: money(body.selling_price),
    stock_quantity: wholeNumber(body.stock_quantity, 0),
    reorder_level: wholeNumber(body.reorder_level, 5),
  };
  let error = null;
  if (!p.name) error = ['Enter a product name.', 'name'];
  else if (!(p.cost_price >= 0)) error = ['Enter a valid cost price.', 'cost_price'];
  else if (!(p.selling_price >= 0)) error = ['Enter a selling price.', 'selling_price'];
  else if (!(p.stock_quantity >= 0)) error = ['Stock must be a whole number, 0 or more.', 'stock_quantity'];
  else if (!(p.reorder_level >= 0)) error = ['Reorder level must be a whole number, 0 or more.', 'reorder_level'];
  return { product: p, error };
}

function uniqueViolation(err) {
  return err && err.code === '23505';
}

async function saveImage(client, productId, body) {
  if (body.remove_image === '1' || body.remove_image === true) {
    await client.query('DELETE FROM product_images WHERE product_id = $1', [productId]);
    return;
  }
  if (!body.image_data) return;
  const match = IMAGE_PATTERN.exec(body.image_data);
  if (!match) throw Object.assign(new Error('Use a JPEG, PNG or WebP photo.'), { field: 'image' });
  const data = Buffer.from(match[2], 'base64');
  if (data.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('That photo is too large.'), { field: 'image' });
  await client.query(
    `INSERT INTO product_images (product_id, data, mime) VALUES ($1, $2, $3)
     ON CONFLICT (product_id) DO UPDATE SET data = EXCLUDED.data, mime = EXCLUDED.mime, updated_at = NOW()`,
    [productId, data, match[1]]
  );
}

// ---- Pages ----

async function listProducts(req, res, next) {
  try {
    const [products, categories, options] = await Promise.all([
      query(
        `SELECT p.id, p.name, p.barcode, p.category_id, p.cost_price, p.selling_price, p.stock_quantity,
                p.reorder_level, p.active, p.sizes, p.colors,
                c.name AS category_name, c.parent_id AS category_parent_id, g.name AS group_name,
                pi.updated_at AS image_updated_at
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN categories g ON g.id = c.parent_id
         LEFT JOIN product_images pi ON pi.product_id = p.id
         ORDER BY p.active DESC, p.name ASC`
      ).then((r) => r.rows),
      query('SELECT id, name, parent_id FROM categories ORDER BY name').then((r) => r.rows),
      query('SELECT kind, value FROM product_attribute_options ORDER BY position, id').then((r) => r.rows),
    ]);

    const groups = categories
      .filter((c) => !c.parent_id)
      .map((g) => ({ ...g, children: categories.filter((c) => c.parent_id === g.id) }));
    const types = categories.filter((c) => c.parent_id);

    res.render('admin/products', {
      title: 'Products',
      products: products.map((p) => ({
        ...p,
        // The filter "group" is the parent category, or the category itself when it has no parent.
        group_id: p.category_parent_id || p.category_id || null,
        image_url: p.image_updated_at ? `/admin/products/${p.id}/image?v=${new Date(p.image_updated_at).getTime()}` : null,
      })),
      groups,
      types,
      sizeOptions: options.filter((o) => o.kind === 'size').map((o) => o.value),
      colorOptions: options.filter((o) => o.kind === 'color').map((o) => o.value),
      unitsOnHand: products.filter((p) => p.active).reduce((sum, p) => sum + p.stock_quantity, 0),
    });
  } catch (err) {
    next(err);
  }
}

async function createProduct(req, res, next) {
  const { product: p, error } = readProduct(req.body);
  if (error) return fail(req, res, 422, error[0], error[1]);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO products (name, barcode, category_id, sizes, colors, cost_price, selling_price, stock_quantity, reorder_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [p.name, p.barcode, p.category_id, p.sizes, p.colors, p.cost_price, p.selling_price, p.stock_quantity, p.reorder_level]
    );
    await saveImage(client, rows[0].id, req.body);
    await client.query('COMMIT');
    setFlash(req, 'success', `${p.name} added`);
    if (wantsJson(req)) return res.json({ ok: true, id: rows[0].id });
    res.redirect('/admin/products');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (uniqueViolation(err)) return fail(req, res, 409, 'That SKU / barcode is already used by another product.', 'barcode');
    if (err.field) return fail(req, res, 422, err.message, err.field);
    next(err);
  } finally {
    client.release();
  }
}

async function updateProduct(req, res, next) {
  const { product: p, error } = readProduct(req.body);
  if (error) return fail(req, res, 422, error[0], error[1]);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE products SET name = $1, barcode = $2, category_id = $3, sizes = $4, colors = $5, cost_price = $6,
         selling_price = $7, stock_quantity = $8, reorder_level = $9, updated_at = NOW()
       WHERE id = $10`,
      [p.name, p.barcode, p.category_id, p.sizes, p.colors, p.cost_price, p.selling_price, p.stock_quantity, p.reorder_level, req.params.id]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return fail(req, res, 404, 'That product no longer exists.');
    }
    await saveImage(client, req.params.id, req.body);
    await client.query('COMMIT');
    setFlash(req, 'success', 'Changes saved');
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect('/admin/products');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (uniqueViolation(err)) return fail(req, res, 409, 'That SKU / barcode is already used by another product.', 'barcode');
    if (err.field) return fail(req, res, 422, err.message, err.field);
    next(err);
  } finally {
    client.release();
  }
}

async function setProductActive(req, res, next) {
  try {
    const active = req.body.active === true || req.body.active === 'true' || req.body.active === '1';
    const { rows } = await query('UPDATE products SET active = $1, updated_at = NOW() WHERE id = $2 RETURNING name', [
      active,
      req.params.id,
    ]);
    if (!rows[0]) return fail(req, res, 404, 'That product no longer exists.');
    if (wantsJson(req)) return res.json({ ok: true, active });
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
}

// Requires the exact product name, matching the confirmation dialog.
async function deleteProduct(req, res, next) {
  try {
    const { rows } = await query('SELECT id, name FROM products WHERE id = $1', [req.params.id]);
    const product = rows[0];
    if (!product) return fail(req, res, 404, 'That product no longer exists.');
    if (String(req.body.confirm_name || '').trim() !== product.name) {
      return fail(req, res, 422, `Type "${product.name}" to confirm.`, 'confirm_name');
    }
    await query('DELETE FROM products WHERE id = $1', [product.id]);
    setFlash(req, 'deleted', `${product.name} deleted`);
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
}

async function productImage(req, res, next) {
  try {
    const { rows } = await query('SELECT data, mime FROM product_images WHERE product_id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).end();
    res.set('Content-Type', rows[0].mime);
    res.set('Cache-Control', 'private, max-age=31536000, immutable'); // URL carries a version
    res.send(rows[0].data);
  } catch (err) {
    next(err);
  }
}

async function createCategory(req, res, next) {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const parentId = /^\d+$/.test(String(req.body.parent_id || '')) ? Number(req.body.parent_id) : null;
  try {
    if (!name) return fail(req, res, 422, 'Enter a category name.', 'name');
    if (parentId) {
      const { rows } = await query('SELECT parent_id FROM categories WHERE id = $1', [parentId]);
      if (!rows[0]) return fail(req, res, 422, 'That group no longer exists.', 'parent_id');
      if (rows[0].parent_id) return fail(req, res, 422, 'Pick a top-level group.', 'parent_id');
    }
    const { rows } = await query(
      'INSERT INTO categories (name, parent_id) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING id',
      [name, parentId]
    );
    if (!rows[0]) return fail(req, res, 409, `There's already a category called "${name}".`, 'name');
    setFlash(req, 'success', `Category "${name}" added`);
    if (wantsJson(req)) return res.json({ ok: true, id: rows[0].id });
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
}

// ---- Size & color options offered in the editor ----

function readOption(body) {
  const kind = body.kind === 'color' ? 'color' : body.kind === 'size' ? 'size' : null;
  const value = kind === 'color' ? normalizeColor(body.value) : kind === 'size' ? normalizeSize(body.value) : null;
  return { kind, value };
}

async function addOption(req, res, next) {
  const { kind, value } = readOption(req.body);
  try {
    if (!kind) return res.status(422).json({ error: 'Unknown option type.' });
    if (!value) {
      return res.status(422).json({
        error: kind === 'size' ? 'Use up to 8 letters or numbers for a size.' : 'Pick a valid color.',
      });
    }
    const { rows } = await query(
      `INSERT INTO product_attribute_options (kind, value, position)
       SELECT $1::text, $2::text, COALESCE(MAX(position), 0) + 1 FROM product_attribute_options WHERE kind = $1
       ON CONFLICT (kind, value) DO NOTHING
       RETURNING value`,
      [kind, value]
    );
    if (rows[0]) {
      const { rows: count } = await query('SELECT COUNT(*)::int AS n FROM product_attribute_options WHERE kind = $1', [kind]);
      if (count[0].n > MAX_OPTIONS) {
        await query('DELETE FROM product_attribute_options WHERE kind = $1 AND value = $2', [kind, value]);
        return res.status(422).json({ error: `Keep it to ${MAX_OPTIONS} ${kind}s or fewer.` });
      }
    }
    res.json({ ok: true, value });
  } catch (err) {
    next(err);
  }
}

// Removing an option only takes it off the list; products that already use it keep it.
async function removeOption(req, res, next) {
  const { kind, value } = readOption(req.body);
  try {
    if (!kind || !value) return res.status(422).json({ error: 'Unknown option.' });
    await query('DELETE FROM product_attribute_options WHERE kind = $1 AND value = $2', [kind, value]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ---- CSV import ----

const IMPORT_COLUMNS = ['name', 'sku', 'group', 'type', 'sizes', 'colors', 'cost_price', 'selling_price', 'stock', 'reorder_level'];
const HEADER_ALIASES = {
  'sku/barcode': 'sku',
  barcode: 'sku',
  category: 'type',
  cost: 'cost_price',
  price: 'selling_price',
  stock_quantity: 'stock',
  stock_on_hand: 'stock',
  reorder: 'reorder_level',
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function importTemplate(req, res) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="products-template.csv"');
  res.send(toCsv([IMPORT_COLUMNS]));
}

// Adds new products and updates existing ones (matched by SKU, else by name).
// All rows are checked first; nothing is saved if any row has a problem.
async function importProducts(req, res, next) {
  const rows = parseCsv(req.body.csv || '');
  if (rows.length < 2) return fail(req, res, 422, 'The file needs a header row and at least one product.');
  const header = rows[0].map((h) => {
    const key = h.trim().toLowerCase().replace(/\s+/g, '_');
    return HEADER_ALIASES[key] || key;
  });
  if (!header.includes('name') || !header.includes('selling_price')) {
    return fail(req, res, 422, 'The header row needs at least "name" and "selling_price" columns.');
  }
  if (rows.length > 2001) return fail(req, res, 422, 'Import up to 2,000 products at a time.');

  const records = rows.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] || '').trim()])));
  const problems = [];
  const parsed = records.map((r, i) => {
    const { product, error } = readProduct({
      ...r,
      barcode: r.sku,
      stock_quantity: r.stock,
      colors: list(r.colors).map((c) => (c.startsWith('#') ? c : `#${c}`)),
    });
    if (error) problems.push(`Row ${i + 2}: ${error[0]}`);
    // Columns left blank keep the existing product's value on update.
    const filled = (k) => header.includes(k) && r[k] !== '';
    return { product, group: r.group || '', type: r.type || '', filled };
  });
  if (problems.length) {
    return fail(req, res, 422, problems.slice(0, 3).join(' ') + (problems.length > 3 ? ` (+${problems.length - 3} more)` : ''));
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const categoryIds = new Map();
    async function categoryId(name, parentId) {
      const key = `${parentId || ''}:${name.toLowerCase()}`;
      if (categoryIds.has(key)) return categoryIds.get(key);
      const found = await client.query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1)', [name]);
      const id = found.rows[0]
        ? found.rows[0].id
        : (await client.query('INSERT INTO categories (name, parent_id) VALUES ($1, $2) RETURNING id', [name, parentId])).rows[0].id;
      categoryIds.set(key, id);
      return id;
    }

    let added = 0;
    let updated = 0;
    for (const { product: p, group, type, filled } of parsed) {
      const groupId = group ? await categoryId(group, null) : null;
      p.category_id = type ? await categoryId(type, groupId) : groupId;

      const existing = await client.query(
        p.barcode ? 'SELECT id FROM products WHERE barcode = $1' : 'SELECT id FROM products WHERE LOWER(name) = LOWER($1) ORDER BY id LIMIT 1',
        [p.barcode || p.name]
      );
      if (existing.rows[0]) {
        const sets = { name: p.name, selling_price: p.selling_price };
        if (filled('sku')) sets.barcode = p.barcode;
        if (filled('group') || filled('type')) sets.category_id = p.category_id;
        if (filled('sizes')) sets.sizes = p.sizes;
        if (filled('colors')) sets.colors = p.colors;
        if (filled('cost_price')) sets.cost_price = p.cost_price;
        if (filled('stock')) sets.stock_quantity = p.stock_quantity;
        if (filled('reorder_level')) sets.reorder_level = p.reorder_level;
        const cols = Object.keys(sets);
        await client.query(
          `UPDATE products SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW()
           WHERE id = $${cols.length + 1}`,
          [...Object.values(sets), existing.rows[0].id]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO products (name, barcode, category_id, sizes, colors, cost_price, selling_price, stock_quantity, reorder_level)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [p.name, p.barcode, p.category_id, p.sizes, p.colors, p.cost_price, p.selling_price, p.stock_quantity, p.reorder_level]
        );
        added++;
      }
    }
    await client.query('COMMIT');
    const parts = [added && `${added} added`, updated && `${updated} updated`].filter(Boolean).join(', ');
    setFlash(req, 'success', `Import complete: ${parts || 'no changes'}`);
    if (wantsJson(req)) return res.json({ ok: true, added, updated });
    res.redirect('/admin/products');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (uniqueViolation(err)) return fail(req, res, 409, 'Two rows use the same SKU / barcode.');
    next(err);
  } finally {
    client.release();
  }
}

module.exports = {
  listProducts,
  createProduct,
  updateProduct,
  setProductActive,
  deleteProduct,
  productImage,
  createCategory,
  importTemplate,
  importProducts,
  addOption,
  removeOption,
  parseCsv,
};
