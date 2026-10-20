(function () {
  const products = JSON.parse(document.getElementById('productData').textContent);
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const editorData = JSON.parse(document.getElementById('editorData').textContent);
  const categories = editorData.categories; // groups, each with its sub-categories
  let sizeOptions = editorData.sizes; // store-wide lists, edited with + and ×
  let colorOptions = editorData.colors;

  const form = document.getElementById('productForm');
  const title = document.getElementById('editorTitle');
  const sub = document.getElementById('editorSub');
  const cancelBtn = document.getElementById('cancelEdit');
  const saveBtn = document.getElementById('saveProduct');
  const deleteBtn = document.getElementById('openDelete');
  const stockLabel = document.getElementById('stockLabel');
  const formError = document.getElementById('formError');
  const colorPicker = document.getElementById('colorPicker');
  const colorAdd = document.getElementById('colorAdd');
  const dropzone = document.getElementById('dropzone');
  const dropzoneContent = document.getElementById('dropzoneContent');
  const photoInput = document.getElementById('photoInput');
  const imageData = document.getElementById('imageData');
  const removeImage = document.getElementById('removeImage');
  const categorySelect = document.getElementById('pCategory');
  const subcategorySelect = document.getElementById('pSubcategory');
  const sizeBox = document.getElementById('sizeOptions');
  const addSizeBtn = document.getElementById('addSizeBtn');
  const addSizeInput = document.getElementById('addSizeInput');
  const fields = {
    name: document.getElementById('pName'),
    barcode: document.getElementById('pSku'),
    cost_price: document.getElementById('pCost'),
    selling_price: document.getElementById('pPrice'),
    stock_quantity: document.getElementById('pStock'),
    reorder_level: document.getElementById('pReorder'),
  };

  let editing = null; // product being edited, or null for "new"
  let selectedSizes = [];
  let selectedColors = [];
  // What the editor shows: the store-wide options plus any the product
  // already uses that aren't on the list (e.g. from a CSV import).
  let shownSizes = [];
  let shownColors = [];

  // ---- Small helpers ----

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = { error: 'Something went wrong. Please try again.' };
    }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { field: data.field });
    return data;
  }

  function toast(message, type) {
    if (window.showToast) window.showToast(message, type);
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function openModal(modal, focusEl) {
    modal.hidden = false;
    modal.dataset.returnFocus = document.activeElement && document.activeElement.id ? document.activeElement.id : '';
    (focusEl || modal.querySelector('input, select, button')).focus();
  }

  function closeModal(modal) {
    modal.hidden = true;
    const back = modal.dataset.returnFocus && document.getElementById(modal.dataset.returnFocus);
    if (back) back.focus();
  }

  document.querySelectorAll('.modal-backdrop').forEach((modal) => {
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(modal)));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.modal-backdrop:not([hidden])');
    if (open) closeModal(open);
  });

  // ---- Filtering ----

  const search = document.getElementById('productFilter');
  const rows = Array.from(document.querySelectorAll('#productTable tbody tr'));
  const noMatches = document.getElementById('noMatches');
  const typeChips = Array.from(document.querySelectorAll('.tchip'));
  let groupFilter = '';
  let typeFilter = '';

  function applyFilters() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    rows.forEach((row) => {
      const match =
        (!q || row.dataset.search.includes(q)) &&
        (!groupFilter || row.dataset.group === groupFilter) &&
        (!typeFilter || row.dataset.type === typeFilter);
      row.hidden = !match;
      if (match) shown++;
    });
    if (noMatches) noMatches.hidden = shown > 0 || !rows.length;
    typeChips.forEach((chip) => {
      chip.hidden = Boolean(groupFilter) && chip.dataset.parent !== groupFilter;
    });
  }

  search.addEventListener('input', applyFilters);
  document.querySelectorAll('.fpill[data-group]').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.fpill[data-group]').forEach((p) => p.classList.toggle('is-active', p === pill));
      groupFilter = pill.dataset.group;
      typeFilter = '';
      typeChips.forEach((c) => c.classList.remove('is-active'));
      applyFilters();
    });
  });
  typeChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const on = typeFilter !== chip.dataset.type;
      typeFilter = on ? chip.dataset.type : '';
      typeChips.forEach((c) => c.classList.toggle('is-active', on && c === chip));
      applyFilters();
    });
  });

  // ---- Category / sub-category ----

  function fillSubcategories(groupId, selectedId) {
    const group = categories.find((g) => String(g.id) === String(groupId));
    const children = group ? group.children : [];
    subcategorySelect.innerHTML = '';
    const none = new Option('None', '');
    subcategorySelect.add(none);
    children.forEach((c) => subcategorySelect.add(new Option(c.name, c.id)));
    subcategorySelect.disabled = !children.length;
    subcategorySelect.value = selectedId ? String(selectedId) : '';
  }

  // A product's category_id is either a group or one of its sub-categories.
  function setCategory(categoryId) {
    const id = String(categoryId || '');
    const asGroup = categories.find((g) => String(g.id) === id);
    const parent = categories.find((g) => g.children.some((c) => String(c.id) === id));
    categorySelect.value = asGroup ? id : parent ? String(parent.id) : '';
    fillSubcategories(categorySelect.value, parent ? id : '');
  }

  categorySelect.addEventListener('change', () => fillSubcategories(categorySelect.value, ''));

  // ---- Sizes & colors ----

  async function removeOption(kind, value) {
    try {
      await postJson('/admin/product-options/delete', { kind, value });
      if (kind === 'size') sizeOptions = sizeOptions.filter((s) => s !== value);
      else colorOptions = colorOptions.filter((c) => c !== value);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  async function addOption(kind, value) {
    try {
      const { value: saved } = await postJson('/admin/product-options', { kind, value });
      if (kind === 'size' && !sizeOptions.includes(saved)) sizeOptions.push(saved);
      if (kind === 'color' && !colorOptions.includes(saved)) colorOptions.push(saved);
      return saved;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  }

  function removeButton(label, onClick) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'opt-remove';
    x.setAttribute('aria-label', label);
    x.title = label;
    x.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    x.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return x;
  }

  function renderSizes() {
    sizeBox.querySelectorAll('.opt').forEach((el) => el.remove());
    shownSizes.forEach((size) => {
      const wrap = document.createElement('span');
      wrap.className = 'opt';
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = size;
      cb.checked = selectedSizes.includes(size);
      cb.addEventListener('change', () => {
        selectedSizes = cb.checked ? [...selectedSizes, size] : selectedSizes.filter((s) => s !== size);
      });
      const text = document.createElement('span');
      text.textContent = size;
      label.append(cb, text);
      wrap.append(
        label,
        removeButton(`Remove size ${size}`, async () => {
          if (!(await removeOption('size', size))) return;
          shownSizes = shownSizes.filter((s) => s !== size);
          selectedSizes = selectedSizes.filter((s) => s !== size);
          renderSizes();
          addSizeBtn.focus();
        })
      );
      sizeBox.insertBefore(wrap, addSizeBtn);
    });
  }

  function hideSizeInput() {
    addSizeInput.value = '';
    addSizeInput.hidden = true;
    addSizeBtn.hidden = false;
  }

  addSizeBtn.addEventListener('click', () => {
    addSizeBtn.hidden = true;
    addSizeInput.hidden = false;
    addSizeInput.focus();
  });
  addSizeInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideSizeInput();
      addSizeBtn.focus();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = addSizeInput.value.trim();
    if (!value) return hideSizeInput();
    const saved = await addOption('size', value);
    if (!saved) return;
    if (!shownSizes.includes(saved)) shownSizes.push(saved);
    if (!selectedSizes.includes(saved)) selectedSizes.push(saved);
    renderSizes();
    addSizeInput.value = '';
    addSizeInput.focus(); // stay open to add another
  });
  addSizeInput.addEventListener('blur', () => {
    if (!addSizeInput.value.trim()) hideSizeInput();
  });

  function renderColors() {
    colorPicker.querySelectorAll('.opt').forEach((el) => el.remove());
    const addLabel = colorPicker.querySelector('.opt-add');
    shownColors.forEach((hex) => {
      const wrap = document.createElement('span');
      wrap.className = 'opt';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-option';
      btn.style.background = hex;
      btn.title = hex;
      btn.setAttribute('aria-label', `Color ${hex}`);
      btn.setAttribute('aria-pressed', selectedColors.includes(hex) ? 'true' : 'false');
      btn.addEventListener('click', () => {
        selectedColors = selectedColors.includes(hex) ? selectedColors.filter((c) => c !== hex) : [...selectedColors, hex];
        btn.setAttribute('aria-pressed', selectedColors.includes(hex) ? 'true' : 'false');
      });
      wrap.append(
        btn,
        removeButton(`Remove color ${hex}`, async () => {
          if (!(await removeOption('color', hex))) return;
          shownColors = shownColors.filter((c) => c !== hex);
          selectedColors = selectedColors.filter((c) => c !== hex);
          renderColors();
        })
      );
      colorPicker.insertBefore(wrap, addLabel);
    });
  }

  colorAdd.addEventListener('change', async () => {
    const saved = await addOption('color', colorAdd.value);
    if (!saved) return;
    if (!shownColors.includes(saved)) shownColors.push(saved);
    if (!selectedColors.includes(saved)) selectedColors.push(saved);
    renderColors();
  });

  function resetOptions(product) {
    selectedSizes = product ? [...product.sizes] : [];
    selectedColors = product ? [...product.colors] : [];
    shownSizes = [...sizeOptions, ...selectedSizes.filter((s) => !sizeOptions.includes(s))];
    shownColors = [...colorOptions, ...selectedColors.filter((c) => !colorOptions.includes(c))];
    hideSizeInput();
    renderSizes();
    renderColors();
  }

  // ---- Photo ----

  function showPhoto(src) {
    dropzone.classList.toggle('has-image', Boolean(src));
    dropzoneContent.innerHTML = '';
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      const text = document.createElement('span');
      text.textContent = 'Change photo';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dropzone-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        imageData.value = '';
        removeImage.value = '1';
        photoInput.value = '';
        showPhoto(null);
      });
      dropzoneContent.append(img, text, remove);
    } else if (editing) {
      dropzoneContent.innerHTML = editing.icon;
      const text = document.createElement('span');
      text.textContent = 'Add photo';
      dropzoneContent.appendChild(text);
    } else {
      dropzoneContent.textContent = 'Drop image or browse';
    }
  }

  // Shrinks the photo in the browser so uploads stay small.
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not an image we can read.'));
        img.onload = () => {
          const max = 640;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function takePhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast('Choose an image file.', 'error');
    try {
      const data = await resizeImage(file);
      imageData.value = data;
      removeImage.value = '';
      showPhoto(data);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  photoInput.addEventListener('change', () => takePhoto(photoInput.files[0]));
  ['dragenter', 'dragover'].forEach((t) =>
    dropzone.addEventListener(t, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, () => dropzone.classList.remove('is-over')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    takePhoto(e.dataTransfer.files[0]);
  });

  // ---- Editor (new / edit) ----

  function clearErrors() {
    formError.hidden = true;
    form.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
  }

  function showError(message, field) {
    formError.textContent = message;
    formError.hidden = false;
    const el = fields[field];
    if (el) {
      el.classList.add('is-invalid');
      el.focus();
    }
  }

  function setSaveLabel(text, iconName) {
    document.getElementById('saveLabel').textContent = text;
    saveBtn.querySelectorAll('[data-icon]').forEach((el) => {
      el.hidden = el.dataset.icon !== iconName;
      el.style.display = el.hidden ? '' : 'contents';
    });
  }

  function startNew() {
    editing = null;
    form.reset();
    form.classList.remove('is-editing');
    form.action = '/admin/products';
    title.textContent = 'New product';
    sub.textContent = 'Sizes and colors show as tags; stock is one count per product';
    stockLabel.textContent = 'Opening stock';
    cancelBtn.hidden = true;
    deleteBtn.hidden = true;
    setSaveLabel('Add product', 'plus');
    fields.reorder_level.value = 5;
    setCategory('');
    resetOptions(null);
    imageData.value = '';
    removeImage.value = '';
    showPhoto(null);
    clearErrors();
    rows.forEach((r) => r.classList.remove('is-selected'));
  }

  function startEdit(product) {
    editing = product;
    form.reset();
    form.classList.add('is-editing');
    form.action = `/admin/products/${product.id}`;
    title.textContent = 'Edit product';
    sub.textContent = product.barcode ? `Editing ${product.barcode}` : `Editing ${product.name}`;
    stockLabel.textContent = 'Stock on hand (total)';
    cancelBtn.hidden = false;
    deleteBtn.hidden = false;
    setSaveLabel('Save changes', 'check');
    Object.entries(fields).forEach(([key, el]) => {
      el.value = product[key] === null || product[key] === undefined ? '' : product[key];
    });
    setCategory(product.category_id);
    resetOptions(product);
    imageData.value = '';
    removeImage.value = '';
    showPhoto(product.image_url);
    clearErrors();
    rows.forEach((r) => r.classList.toggle('is-selected', r.dataset.id === String(product.id)));
    if (window.matchMedia('(max-width: 1200px)').matches) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    fields.name.focus({ preventScroll: true });
  }

  rows.forEach((row) => {
    const open = (e) => {
      if (e.target.closest('.switch')) return;
      const product = byId.get(row.dataset.id);
      if (product) startEdit(product);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === row) open(e);
    });
  });

  document.getElementById('newProduct').addEventListener('click', () => {
    startNew();
    fields.name.focus();
  });
  cancelBtn.addEventListener('click', startNew);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    if (!fields.name.value.trim()) return showError('Enter a product name.', 'name');
    if (fields.selling_price.value === '') return showError('Enter a selling price.', 'selling_price');

    const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
    body.category_id = subcategorySelect.value || categorySelect.value;
    body.sizes = shownSizes.filter((s) => selectedSizes.includes(s)); // keep the on-screen order
    body.colors = shownColors.filter((c) => selectedColors.includes(c));
    body.image_data = imageData.value;
    body.remove_image = removeImage.value;

    setBusy(saveBtn, true);
    try {
      await postJson(form.action, body);
      location.reload(); // the server queued a toast for the next page
    } catch (err) {
      setBusy(saveBtn, false);
      showError(err.message, err.field);
    }
  });

  // ---- Active toggle ----

  document.querySelectorAll('[data-active-toggle]').forEach((toggle) => {
    toggle.addEventListener('click', (e) => e.stopPropagation());
    toggle.addEventListener('change', async () => {
      const row = toggle.closest('tr');
      toggle.disabled = true;
      try {
        await postJson(`/admin/products/${toggle.dataset.activeToggle}/active`, { active: toggle.checked });
        row.classList.toggle('is-inactive', !toggle.checked);
        toggle.title = toggle.checked ? 'Shown in POS' : 'Hidden from POS';
        toast(toggle.checked ? 'Product is active in the POS' : 'Product hidden from the POS');
      } catch (err) {
        toggle.checked = !toggle.checked;
        toast(err.message, 'error');
      } finally {
        toggle.disabled = false;
      }
    });
  });

  // ---- Delete ----

  const deleteModal = document.getElementById('deleteModal');
  const deleteForm = document.getElementById('deleteForm');
  const confirmName = document.getElementById('confirmName');
  const confirmDelete = document.getElementById('confirmDelete');

  deleteBtn.addEventListener('click', () => {
    if (!editing) return;
    deleteModal.querySelectorAll('[data-name]').forEach((el) => {
      el.textContent = editing.name;
    });
    confirmName.value = '';
    confirmDelete.disabled = true;
    openModal(deleteModal, confirmName);
  });
  confirmName.addEventListener('input', () => {
    confirmDelete.disabled = !editing || confirmName.value.trim() !== editing.name;
  });
  deleteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editing || confirmName.value.trim() !== editing.name) return;
    setBusy(confirmDelete, true);
    try {
      await postJson(`/admin/products/${editing.id}/delete`, { confirm_name: confirmName.value.trim() });
      location.reload();
    } catch (err) {
      setBusy(confirmDelete, false);
      toast(err.message, 'error');
    }
  });

  // ---- Category ----

  const categoryModal = document.getElementById('categoryModal');
  const categoryForm = document.getElementById('categoryForm');
  document.getElementById('openCategory').addEventListener('click', () => {
    categoryForm.reset();
    categoryForm.querySelector('[data-error]').hidden = true;
    openModal(categoryModal, document.getElementById('categoryName'));
  });
  categoryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const error = categoryForm.querySelector('[data-error]');
    const button = categoryForm.querySelector('button[type="submit"]');
    error.hidden = true;
    setBusy(button, true);
    try {
      await postJson('/admin/categories', {
        name: document.getElementById('categoryName').value,
        parent_id: document.getElementById('categoryParent').value,
      });
      location.reload();
    } catch (err) {
      setBusy(button, false);
      error.textContent = err.message;
      error.hidden = false;
    }
  });

  // ---- CSV import ----

  const importModal = document.getElementById('importModal');
  const importForm = document.getElementById('importForm');
  const importFile = document.getElementById('importFile');
  const importSubmit = document.getElementById('importSubmit');
  document.getElementById('openImport').addEventListener('click', () => {
    importForm.reset();
    importSubmit.disabled = true;
    importForm.querySelector('[data-error]').hidden = true;
    openModal(importModal, importFile);
  });
  importFile.addEventListener('change', () => {
    importSubmit.disabled = !importFile.files.length;
  });
  importForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = importFile.files[0];
    if (!file) return;
    const error = importForm.querySelector('[data-error]');
    error.hidden = true;
    setBusy(importSubmit, true);
    try {
      await postJson('/admin/products/import', { csv: await file.text() });
      location.reload();
    } catch (err) {
      setBusy(importSubmit, false);
      error.textContent = err.message;
      error.hidden = false;
    }
  });

  startNew();
})();
