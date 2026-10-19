const bcrypt = require('bcryptjs');
const { query, getClient } = require('../config/db');
const { setFlash } = require('../middleware/flash');
const { tempPassword } = require('../utils/helpers');

async function dashboard(req, res, next) {
  try {
    const [todayTotal, weekTotal, monthTotal, trend, topProducts, lowStock, recentSales] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS count
         FROM sales WHERE created_at::date = CURRENT_DATE`
      ).then((r) => r.rows[0]),
      query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS count
         FROM sales WHERE created_at >= NOW() - INTERVAL '6 days'`
      ).then((r) => r.rows[0]),
      query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS count
         FROM sales WHERE to_char(created_at, 'YYYY-MM') = to_char(NOW(), 'YYYY-MM')`
      ).then((r) => r.rows[0]),
      query(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, COALESCE(SUM(total_amount), 0) AS total
         FROM sales
         WHERE created_at >= NOW() - INTERVAL '6 days'
         GROUP BY day
         ORDER BY day`
      ).then((r) => r.rows),
      query(
        `SELECT sale_items.product_name, SUM(sale_items.quantity) AS units_sold, SUM(sale_items.subtotal) AS revenue
         FROM sale_items
         JOIN sales ON sales.id = sale_items.sale_id
         WHERE sales.created_at >= NOW() - INTERVAL '29 days'
         GROUP BY sale_items.product_id, sale_items.product_name
         ORDER BY revenue DESC
         LIMIT 5`
      ).then((r) => r.rows),
      query(
        `SELECT name, stock_quantity, reorder_level, unit FROM products
         WHERE active = TRUE AND stock_quantity <= reorder_level ORDER BY stock_quantity ASC`
      ).then((r) => r.rows),
      query(
        `SELECT sales.id, receipt_no, total_amount, sales.created_at, users.full_name AS cashier
         FROM sales JOIN users ON users.id = sales.user_id
         ORDER BY sales.created_at DESC LIMIT 8`
      ).then((r) => r.rows),
    ]);

    // Fill in missing days with zero so the trend chart has a full 7-day axis.
    const trendByDay = Object.fromEntries(trend.map((r) => [r.day, r.total]));
    const trendData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      trendData.push({ day: key, total: trendByDay[key] || 0 });
    }

    res.render('admin/dashboard', {
      title: 'Dashboard',
      todayTotal,
      weekTotal,
      monthTotal,
      trendData,
      topProducts,
      lowStock,
      recentSales,
    });
  } catch (err) {
    next(err);
  }
}

// ---- Products ----

async function listProducts(req, res, next) {
  try {
    const [products, categories] = await Promise.all([
      query(
        `SELECT products.*, categories.name AS category_name
         FROM products LEFT JOIN categories ON categories.id = products.category_id
         ORDER BY products.active DESC, products.name ASC`
      ).then((r) => r.rows),
      query('SELECT * FROM categories ORDER BY name').then((r) => r.rows),
    ]);
    res.render('admin/products', { title: 'Products', products, categories });
  } catch (err) {
    next(err);
  }
}

async function createProduct(req, res, next) {
  const { name, barcode, category_id, unit, cost_price, selling_price, stock_quantity, reorder_level } = req.body;
  try {
    await query(
      `INSERT INTO products (name, barcode, category_id, unit, cost_price, selling_price, stock_quantity, reorder_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        name,
        barcode || null,
        category_id || null,
        unit || 'pc',
        Number(cost_price) || 0,
        Number(selling_price) || 0,
        Number(stock_quantity) || 0,
        Number(reorder_level) || 5,
      ]
    );
    setFlash(req, 'success', `Product "${name}" added.`);
    res.redirect('/admin/products');
  } catch (err) {
    setFlash(req, 'error', `Could not add product: ${err.message}`);
    res.redirect('/admin/products');
  }
}

async function updateProduct(req, res, next) {
  const { id } = req.params;
  const { name, barcode, category_id, unit, cost_price, selling_price, stock_quantity, reorder_level, active } = req.body;
  try {
    await query(
      `UPDATE products SET name = $1, barcode = $2, category_id = $3, unit = $4, cost_price = $5, selling_price = $6,
       stock_quantity = $7, reorder_level = $8, active = $9, updated_at = NOW()
       WHERE id = $10`,
      [
        name,
        barcode || null,
        category_id || null,
        unit || 'pc',
        Number(cost_price) || 0,
        Number(selling_price) || 0,
        Number(stock_quantity) || 0,
        Number(reorder_level) || 5,
        Boolean(active),
        id,
      ]
    );
    setFlash(req, 'success', `Product "${name}" updated.`);
    res.redirect('/admin/products');
  } catch (err) {
    setFlash(req, 'error', `Could not update product: ${err.message}`);
    res.redirect('/admin/products');
  }
}

async function createCategory(req, res, next) {
  const { name } = req.body;
  try {
    if (name && name.trim()) {
      await query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name.trim()]);
    }
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
}

// ---- Users ----

async function listUsers(req, res, next) {
  try {
    const [{ rows: users }, { rows: accessRequests }, { rows: resetRequests }] = await Promise.all([
      query('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY role, username'),
      query("SELECT * FROM access_requests WHERE status = 'pending' ORDER BY created_at"),
      query(
        `SELECT password_reset_requests.*, users.username, users.full_name, users.contact
         FROM password_reset_requests JOIN users ON users.id = password_reset_requests.user_id
         WHERE password_reset_requests.status = 'pending' ORDER BY password_reset_requests.created_at`
      ),
    ]);
    res.render('admin/users', { title: 'Users', users, accessRequests, resetRequests });
  } catch (err) {
    next(err);
  }
}

async function createUser(req, res, next) {
  const { username, password, full_name, role } = req.body;
  try {
    const hash = bcrypt.hashSync(password, 10);
    await query('INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)', [
      username,
      hash,
      full_name,
      role === 'admin' ? 'admin' : 'sales_rep',
    ]);
    setFlash(req, 'success', `User "${username}" created.`);
    res.redirect('/admin/users');
  } catch (err) {
    setFlash(req, 'error', `Could not create user: ${err.message}`);
    res.redirect('/admin/users');
  }
}

async function toggleUserActive(req, res, next) {
  const { id } = req.params;
  try {
    if (Number(id) === req.session.user.id) {
      setFlash(req, 'error', 'You cannot deactivate your own account.');
      return res.redirect('/admin/users');
    }
    await query('UPDATE users SET active = NOT active WHERE id = $1', [id]);
    res.redirect('/admin/users');
  } catch (err) {
    next(err);
  }
}

// ---- Access & password-reset requests ----

// Shared on every admin page so the nav can flag requests waiting for review.
async function pendingRequestCount(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT (SELECT COUNT(*) FROM access_requests WHERE status = 'pending')
            + (SELECT COUNT(*) FROM password_reset_requests WHERE status = 'pending') AS count`
    );
    res.locals.pendingRequests = Number(rows[0].count);
    next();
  } catch (err) {
    next(err);
  }
}

async function approveAccessRequest(req, res, next) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT * FROM access_requests WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [req.params.id]
    );
    const request = rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      setFlash(req, 'error', 'That request was already handled.');
      return res.redirect('/admin/users');
    }

    const { rows: taken } = await client.query('SELECT 1 FROM users WHERE LOWER(username) = $1', [request.username]);
    if (taken.length) {
      await client.query('ROLLBACK');
      setFlash(req, 'error', `The username "${request.username}" is already taken. Reject this request or add the user manually.`);
      return res.redirect('/admin/users');
    }

    const password = tempPassword();
    await client.query(
      `INSERT INTO users (username, password_hash, full_name, role, contact, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE)`,
      [request.username, bcrypt.hashSync(password, 10), request.full_name, request.role, request.contact]
    );
    await client.query("UPDATE access_requests SET status = 'approved', resolved_at = NOW() WHERE id = $1", [
      request.id,
    ]);
    await client.query('COMMIT');

    setFlash(
      req,
      'success',
      `Created "${request.username}". Temporary password: ${password} — send it to ${request.contact}. They'll choose their own when they sign in.`
    );
    res.redirect('/admin/users');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

async function rejectAccessRequest(req, res, next) {
  try {
    await query("UPDATE access_requests SET status = 'rejected', resolved_at = NOW() WHERE id = $1 AND status = 'pending'", [
      req.params.id,
    ]);
    setFlash(req, 'success', 'Access request rejected.');
    res.redirect('/admin/users');
  } catch (err) {
    next(err);
  }
}

async function resolvePasswordReset(req, res, next) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT password_reset_requests.id, users.id AS user_id, users.username, users.contact
       FROM password_reset_requests JOIN users ON users.id = password_reset_requests.user_id
       WHERE password_reset_requests.id = $1 AND password_reset_requests.status = 'pending'
       FOR UPDATE OF password_reset_requests`,
      [req.params.id]
    );
    const request = rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      setFlash(req, 'error', 'That request was already handled.');
      return res.redirect('/admin/users');
    }

    const password = tempPassword();
    await client.query('UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2', [
      bcrypt.hashSync(password, 10),
      request.user_id,
    ]);
    await client.query("UPDATE password_reset_requests SET status = 'resolved', resolved_at = NOW() WHERE id = $1", [
      request.id,
    ]);
    await client.query('COMMIT');

    const reach = request.contact ? ` Send it to ${request.contact}.` : '';
    setFlash(
      req,
      'success',
      `Temporary password for "${request.username}": ${password}.${reach} They'll choose a new one when they sign in.`
    );
    res.redirect('/admin/users');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

async function dismissPasswordReset(req, res, next) {
  try {
    await query(
      "UPDATE password_reset_requests SET status = 'dismissed', resolved_at = NOW() WHERE id = $1 AND status = 'pending'",
      [req.params.id]
    );
    setFlash(req, 'success', 'Password reset request dismissed.');
    res.redirect('/admin/users');
  } catch (err) {
    next(err);
  }
}

// ---- Sales ----

async function listSales(req, res, next) {
  const { from, to } = req.query;
  try {
    let text = `SELECT sales.id, receipt_no, total_amount, amount_paid, change_amount, sales.created_at, users.full_name AS cashier
                FROM sales JOIN users ON users.id = sales.user_id`;
    const conditions = [];
    const params = [];
    if (from) {
      params.push(from);
      conditions.push(`sales.created_at::date >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      conditions.push(`sales.created_at::date <= $${params.length}::date`);
    }
    if (conditions.length) text += ' WHERE ' + conditions.join(' AND ');
    text += ' ORDER BY sales.created_at DESC LIMIT 200';

    const { rows: sales } = await query(text, params);
    res.render('admin/sales', { title: 'Sales', sales, from: from || '', to: to || '' });
  } catch (err) {
    next(err);
  }
}

async function viewSale(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT sales.*, users.full_name AS cashier FROM sales JOIN users ON users.id = sales.user_id WHERE sales.id = $1`,
      [req.params.id]
    );
    const sale = rows[0];
    if (!sale) return res.status(404).render('error', { title: 'Not Found', message: 'Sale not found.' });
    const { rows: items } = await query('SELECT * FROM sale_items WHERE sale_id = $1', [sale.id]);
    res.render('admin/sale_detail', { title: 'Sale Detail', sale, items });
  } catch (err) {
    next(err);
  }
}

// ---- Inventory reports (submitted by sales reps) ----

async function listInventoryReports(req, res, next) {
  try {
    const { rows: reports } = await query(
      `SELECT inventory_reports.*, products.name AS product_name, users.full_name AS reported_by
       FROM inventory_reports
       JOIN products ON products.id = inventory_reports.product_id
       JOIN users ON users.id = inventory_reports.user_id
       ORDER BY inventory_reports.created_at DESC LIMIT 200`
    );
    res.render('admin/inventory_reports', { title: 'Inventory Reports', reports });
  } catch (err) {
    next(err);
  }
}

// ---- JSON API for dashboard chart ----

async function salesChartData(req, res, next) {
  try {
    const days = Math.min(Number(req.query.days) || 7, 90);
    const { rows } = await query(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, COALESCE(SUM(total_amount), 0) AS total
       FROM sales
       WHERE created_at >= NOW() - ($1::text || ' days')::interval
       GROUP BY day ORDER BY day`,
      [String(days - 1)]
    );
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.total]));
    const labels = [];
    const totals = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      labels.push(key);
      totals.push(byDay[key] || 0);
    }
    res.json({ labels, totals });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  dashboard,
  listProducts,
  createProduct,
  updateProduct,
  createCategory,
  listUsers,
  createUser,
  toggleUserActive,
  pendingRequestCount,
  approveAccessRequest,
  rejectAccessRequest,
  resolvePasswordReset,
  dismissPasswordReset,
  listSales,
  viewSale,
  listInventoryReports,
  salesChartData,
};
