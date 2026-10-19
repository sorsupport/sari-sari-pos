function homeFor(user) {
  if (user.mustChangePassword) return '/change-password';
  return user.role === 'admin' ? '/admin/dashboard' : '/pos';
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  // Signed in with a temporary password: nothing else until they pick their own.
  if (req.session.user.mustChangePassword) {
    return res.redirect('/change-password');
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (req.session.user.role !== role) {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: 'You do not have permission to view this page.',
      });
    }
    next();
  };
}

function redirectIfAuthed(req, res, next) {
  if (req.session.user) {
    return res.redirect(homeFor(req.session.user));
  }
  next();
}

module.exports = { requireAuth, requireRole, redirectIfAuthed, homeFor };
