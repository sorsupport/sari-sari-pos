const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { redirectIfAuthed, homeFor } = require('../middleware/auth');
const { setFlash } = require('../middleware/flash');

const router = express.Router();

const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;
const MIN_PASSWORD = 6;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ---- Sign in ----

router.get('/login', redirectIfAuthed, (req, res) => {
  res.render('login', { title: 'Sign in', values: {}, error: null });
});

router.post('/login', async (req, res, next) => {
  const username = clean(req.body.username);
  const password = req.body.password || '';
  const remember = req.body.remember === 'on';
  const values = { username, remember };
  try {
    if (!username || !password) {
      return res.status(422).render('login', {
        title: 'Sign in',
        values,
        error: 'Enter your username and password.',
      });
    }

    const { rows } = await query('SELECT * FROM users WHERE username = $1 AND active = TRUE', [username]);
    const user = rows[0];

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).render('login', {
        title: 'Sign in',
        values,
        error: 'Invalid username or password.',
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      mustChangePassword: user.must_change_password,
    };
    req.session.remember = remember;
    if (remember) req.sessionOptions.maxAge = 30 * 24 * 60 * 60 * 1000;

    res.redirect(homeFor(req.session.user));
  } catch (err) {
    next(err);
  }
});

// ---- Forgot password (admin hands out a temporary password) ----

router.get('/forgot-password', redirectIfAuthed, (req, res) => {
  res.render('forgot_password', {
    title: 'Forgot password',
    values: { username: clean(req.query.username) },
    errors: {},
  });
});

router.post('/forgot-password', async (req, res, next) => {
  const username = clean(req.body.username);
  const message = clean(req.body.message);
  try {
    if (!username) {
      return res.status(422).render('forgot_password', {
        title: 'Forgot password',
        values: { username, message },
        errors: { username: 'Enter your username.' },
      });
    }

    // Unknown usernames get the same confirmation, so this form can't be used
    // to find out which accounts exist. The confirmation echoes the username
    // back, so a typo is easy to spot.
    const { rows } = await query('SELECT id FROM users WHERE username = $1 AND active = TRUE', [username]);
    if (rows.length) {
      const userId = rows[0].id;
      const { rowCount } = await query(
        `UPDATE password_reset_requests SET message = $2, created_at = NOW()
         WHERE user_id = $1 AND status = 'pending'`,
        [userId, message || null]
      );
      if (!rowCount) {
        await query('INSERT INTO password_reset_requests (user_id, message) VALUES ($1, $2)', [userId, message || null]);
      }
    }

    req.session.resetSent = username;
    res.redirect('/forgot-password/sent');
  } catch (err) {
    next(err);
  }
});

router.get('/forgot-password/sent', (req, res) => {
  const username = req.session.resetSent;
  if (!username) return res.redirect('/forgot-password');
  delete req.session.resetSent;
  res.render('forgot_password_sent', { title: 'Request sent', username });
});

// ---- Request access (admin approves and creates the account) ----

router.get('/request-access', redirectIfAuthed, (req, res) => {
  res.render('request_access', { title: 'Request access', values: { role: 'sales_rep' }, errors: {} });
});

router.post('/request-access', async (req, res, next) => {
  const values = {
    full_name: clean(req.body.full_name),
    username: clean(req.body.username).toLowerCase(),
    contact: clean(req.body.contact),
    role: req.body.role === 'admin' ? 'admin' : 'sales_rep',
    note: clean(req.body.note),
  };
  const errors = {};
  try {
    if (!values.full_name) errors.full_name = 'Enter your full name.';
    if (!values.username) {
      errors.username = 'Choose a username.';
    } else if (!USERNAME_PATTERN.test(values.username)) {
      errors.username = 'Use 3–30 lowercase letters, numbers, dots, dashes or underscores.';
    }
    if (!values.contact) errors.contact = 'Enter an email or mobile number.';

    if (!errors.username) {
      const { rows: taken } = await query('SELECT 1 FROM users WHERE LOWER(username) = $1', [values.username]);
      if (taken.length) {
        errors.username = 'That username is already taken.';
      } else {
        const { rows: pending } = await query(
          "SELECT 1 FROM access_requests WHERE username = $1 AND status = 'pending'",
          [values.username]
        );
        if (pending.length) errors.username = 'A request for this username is already waiting for approval.';
      }
    }

    if (Object.keys(errors).length) {
      return res.status(422).render('request_access', { title: 'Request access', values, errors });
    }

    await query(
      'INSERT INTO access_requests (full_name, username, contact, role, note) VALUES ($1, $2, $3, $4, $5)',
      [values.full_name, values.username, values.contact, values.role, values.note || null]
    );

    req.session.accessSent = { fullName: values.full_name, contact: values.contact };
    res.redirect('/request-access/sent');
  } catch (err) {
    next(err);
  }
});

router.get('/request-access/sent', (req, res) => {
  const sent = req.session.accessSent;
  if (!sent) return res.redirect('/request-access');
  delete req.session.accessSent;
  res.render('request_access_sent', { title: 'Request submitted', ...sent });
});

// Old self-registration URL.
router.get('/register', (req, res) => res.redirect('/request-access'));

// ---- Choose a new password after signing in with a temporary one ----

router.get('/change-password', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('change_password', { title: 'Set a new password', errors: {} });
});

router.post('/change-password', async (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  const password = req.body.password || '';
  const confirm = req.body.confirm_password || '';
  const errors = {};
  try {
    if (password.length < MIN_PASSWORD) {
      errors.password = `Use at least ${MIN_PASSWORD} characters.`;
    } else if (password !== confirm) {
      errors.confirm_password = 'Passwords do not match.';
    } else {
      const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.user.id]);
      if (rows[0] && bcrypt.compareSync(password, rows[0].password_hash)) {
        errors.password = 'Choose a password different from your temporary one.';
      }
    }

    if (Object.keys(errors).length) {
      return res.status(422).render('change_password', { title: 'Set a new password', errors });
    }

    await query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [
      bcrypt.hashSync(password, 10),
      req.session.user.id,
    ]);
    req.session.user = { ...req.session.user, mustChangePassword: false };
    setFlash(req, 'success', 'Password updated.');
    res.redirect(homeFor(req.session.user));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
