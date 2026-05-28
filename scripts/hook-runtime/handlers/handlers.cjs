'use strict';
// Transitional authoring-root marker for pre-cutover Traffic One installs.
//
// The installed Traffic One plugin (<= 2.9.70) detects THIS repository as its own
// authoring root by the existence of this file. That detection suppresses
// auth-gating, new-project onboarding, and self-materialization while the plugin
// is developed in-place. The post-cutover runtime resolves the authoring root via
// scripts/hook-runtime.cjs + src/.authoring-root + manifest name instead, so this
// file is only a compatibility shim for the stale installed build. It carries no
// runtime logic (the installed plugin executes its own cached copy, not this one)
// and can be removed once the plugin is rebuilt from src/ and reinstalled.
module.exports = {};
