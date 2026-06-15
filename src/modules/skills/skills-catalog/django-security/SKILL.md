---
name: django-security
description: Django security best practices, authentication, authorization, CSRF protection, SQL injection prevention, XSS prevention, and secure deployment configurations.
metadata:
  source: everything-claude-code
  source_path: skills/django-security/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Django Security Best Practices

Comprehensive security guidelines for Django applications to protect against common vulnerabilities.

## When to Activate

- Setting up Django authentication and authorization
- Implementing user permissions and roles
- Configuring production security settings
- Reviewing Django application for security issues
- Deploying Django applications to production

The framework-agnostic security checklist (secrets, input validation, parameterized SQL, output escaping, authn/authz, CORS, rate limiting, security headers, dependency audit, error sanitization) and the Traffic One pre-deploy gate are owned by the always-on `rules/common/security.md` — that rule is the source of truth; do not restate or fork it here. Below are only the framework-specific specifics.

## Core Security Settings

### Production Settings Configuration

```python
# settings/production.py
import os

DEBUG = False  # CRITICAL: Never use True in production

ALLOWED_HOSTS = os.environ.get('ALLOWED_HOSTS', '').split(',')

# Security headers
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 31536000  # 1 year
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_BROWSER_XSS_FILTER = True
X_FRAME_OPTIONS = 'DENY'

# HTTPS and Cookies
SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SAMESITE = 'Lax'

# Secret key (must be set via environment variable)
SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY')
if not SECRET_KEY:
    raise ImproperlyConfigured('DJANGO_SECRET_KEY environment variable is required')

# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
        'OPTIONS': {
            'min_length': 12,
        }
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]
```

## Authentication

Use Django's built-in auth, Django REST Framework authentication classes, or a
managed identity provider before custom password/session/JWT code.

### Custom User Model

```python
# apps/users/models.py
from django.contrib.auth.models import AbstractUser
from django.db import models

class User(AbstractUser):
    """Custom user model for better security."""

    email = models.EmailField(unique=True)
    phone = models.CharField(max_length=20, blank=True)

    USERNAME_FIELD = 'email'  # Use email as username
    REQUIRED_FIELDS = ['username']

    class Meta:
        db_table = 'users'
        verbose_name = 'User'
        verbose_name_plural = 'Users'

    def __str__(self):
        return self.email

# settings/base.py
AUTH_USER_MODEL = 'users.User'
```

### Password Hashing

```python
# Django uses PBKDF2 by default. For stronger security:
PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.Argon2PasswordHasher',
    'django.contrib.auth.hashers.PBKDF2PasswordHasher',
    'django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher',
    'django.contrib.auth.hashers.BCryptSHA256PasswordHasher',
]
```

### Session Management

```python
# Session configuration
SESSION_ENGINE = 'django.contrib.sessions.backends.cache'  # Or 'db'
SESSION_CACHE_ALIAS = 'default'
SESSION_COOKIE_AGE = 3600 * 24 * 7  # 1 week
SESSION_SAVE_EVERY_REQUEST = False
SESSION_EXPIRE_AT_BROWSER_CLOSE = False  # Better UX, but less secure
```

## Authorization

Use Django's permission framework and DRF permission classes; scope querysets to the requesting user and return 403 (not redirect) for denied access.

```python
# views.py — LoginRequired + PermissionRequired, owner-scoped queryset
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.views.generic import UpdateView

class PostUpdateView(LoginRequiredMixin, PermissionRequiredMixin, UpdateView):
    model = Post
    permission_required = 'app.can_edit_others'
    raise_exception = True  # 403 instead of redirect

    def get_queryset(self):
        return Post.objects.filter(author=self.request.user)

# permissions.py — DRF object-level owner check
from rest_framework import permissions

class IsOwnerOrReadOnly(permissions.BasePermission):
    def has_object_permission(self, request, view, obj):
        if request.method in permissions.SAFE_METHODS:
            return True
        return obj.author == request.user
```

## Django-Specific Idioms

- **SQL**: the ORM auto-parameterizes; with `raw()` always pass `params` (`User.objects.raw('... WHERE email = %s', [email])`), never f-string interpolation.
- **XSS**: templates auto-escape `{{ var }}`. Reach for `|safe`/`mark_safe()` only on trusted content; build HTML with variables via `format_html('<span>{}</span>', value)`, never string concatenation.
- **CSRF**: enabled by default — keep `{% csrf_token %}` in forms and send `X-CSRFToken` from JS; set `CSRF_TRUSTED_ORIGINS` for cross-origin SPAs and `@csrf_exempt` only on signature-verified webhooks.
- **File uploads**: validate via `FileField(validators=[...])` checking `os.path.splitext(value.name)` extension and `value.size`; store media off the app domain (S3/CDN), never served directly.
- **Rate limiting**: DRF throttling — `DEFAULT_THROTTLE_RATES` (`anon`/`user`/scoped) plus `UserRateThrottle` subclasses for burst/sustained scopes.
- **API auth**: set DRF `DEFAULT_AUTHENTICATION_CLASSES` (`TokenAuthentication`/`SessionAuthentication`/`JWTAuthentication`) and a default `IsAuthenticated` permission.
- **Headers/CSP**: Django ships `SecurityMiddleware` (set `SECURE_*` flags above); add CSP via `django-csp` rather than hand-rolled middleware.
- **Secrets**: load with `django-environ` (`env('DJANGO_SECRET_KEY')`); keep `.env` gitignored.
- **Logging**: route the `django.security` and `django.request` loggers to a persisted handler at `WARNING`/`ERROR`.
