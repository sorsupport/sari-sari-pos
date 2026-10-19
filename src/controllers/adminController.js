const bcrypt = require('bcryptjs');
const { query, getClient } = require('../config/db');
const { setFlash } = require('../middleware/flash');
const { tempPassword, STORE_TZ, storeToday } = require('../utils/helpers');

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

// Shared on every admin page so the sidebar can flag requests waiting for
// review and inventory reports filed today.
async function pendingRequestCount(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT (SELECT COUNT(*) FROM access_requests WHERE status = 'pending')
            + (SELECT COUNT(*) FROM password_reset_requests WHERE status = 'pending') AS count,
              (SELECT COUNT(*) FROM inventory_reports
               WHERE created_at >= ($2::date)::timestamp AT TIME ZONE $1) AS reports_today`,
      [STORE_TZ, storeToday()]
    );
    res.locals.pendingRequests = Number(rows[0].count);
    res.locals.reportsToday = Number(rows[0].reports_today);
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

    // Requests only ever create sales reps, even ones submitted before the
    // Admin option was disabled; admins are added with the "Add User" form.
    const password = tempPassword();
    await client.query(
      `INSERT INTO users (username, password_hash, full_name, role, contact, must_change_password)
       VALUES ($1, $2, $3, 'sales_rep', $4, TRUE)`,
      [request.username, bcrypt.hashSync(password, 10), request.full_name, request.contact]
    );
    await client.query("UPDATE access_requests SET status = 'approved', resolved_at = NOW() WHERE id = $1", [
      request.id,
    ]);
    await client.query('COMMIT');

    setFlash(
      req,
      'notice',
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
      'notice',
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

// ---- Inventory reports (submitted by sales reps) ----

async function listInventoryReports(req, res, next) {
  try {
    const { rows: reports } = await query(
      `SELECT inventory_reports.*, COALESCE(products.name, 'Deleted product') AS product_name, users.full_name AS reported_by
       FROM inventory_reports
       LEFT JOIN products ON products.id = inventory_reports.product_id
       JOIN users ON users.id = inventory_reports.user_id
       ORDER BY inventory_reports.created_at DESC LIMIT 200`
    );
    res.render('admin/inventory_reports', { title: 'Inventory Reports', reports });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listUsers,
  createUser,
  toggleUserActive,
  pendingRequestCount,
  approveAccessRequest,
  rejectAccessRequest,
  resolvePasswordReset,
  dismissPasswordReset,
  listInventoryReports,
};
