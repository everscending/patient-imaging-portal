import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

// ARCHITECTURE.md §2 "Forbidden imports" — the eight-row table is the
// complete rule set (a ninth row is out of scope, a missing one is a
// defect). Rows are enforced here against app/**, lib/**, and components/**
// — the app module tree the table governs. Files outside that tree
// (next.config.ts, playwright/vitest config, scripts/**, tests/**) are
// infrastructure, not part of the map, and are exempt.
const MODULE_TREE = [
  'app/**/*.ts',
  'app/**/*.tsx',
  'lib/**/*.ts',
  'lib/**/*.tsx',
  'components/**/*.ts',
  'components/**/*.tsx',
]

// The guard row's explicit non-PHI allowlist (ARCHITECTURE.md §2, §5).
// Login and register are unauthenticated entrypoints — §5's PhiTarget union
// has no auth-shaped variant, and ADR-0011 confirms registration links no
// patient record. Health is an unauthenticated dependency-liveness probe
// over metadata. The identity routes are the FR-2 match itself, not a PHI
// read — §5's PhiTarget union has no identity-shaped variant either, and
// lib/access/identity.ts is its own single-purpose seam for this one write
// (ARCHITECTURE.md §4), audited directly via lib/audit/events.ts rather than
// through lib/access/guard.ts. None of these routes has a PHI target to guard.
const GUARD_ALLOWLIST = [
  'app/api/auth/login/route.ts',
  'app/api/auth/register/route.ts',
  'app/api/health/route.ts',
  'app/api/identity/verify/route.ts',
  'app/api/identity/status/route.ts',
  'app/api/profile/route.ts',
  // A secret-guarded system callback; it accepts no patient target or caller
  // session and the job itself owns the service-role dispatch boundary.
  'app/api/jobs/reminders/route.ts',
]

const APP_IMPORT_RE = /(^|\/)app\//
const GUARD_IMPORT_RE = /(^|\/)lib\/access\/guard(\.ts)?$/
const REPORT_VIEW_NAME_RE = /ReportView$/

// Every row below is its own local rule, even the five that are really just
// a `no-restricted-imports`/`no-restricted-syntax` call, rather than
// multiple flat-config objects setting those two builtin rule *keys* over
// overlapping "files" globs. Flat config merges "rules" per key across every
// matching object — the last matching object for a given key wins outright,
// it does not accumulate. Eight rows sharing two builtin keys over
// overlapping globs would silently stomp each other down to the last row's
// options. Distinct rule names sidestep that: each config object below sets
// a key none of the others touch.
function restrictedImport(message, isRestricted) {
  return {
    meta: { type: 'problem', docs: { description: message }, schema: [] },
    create(context) {
      return {
        ImportDeclaration(node) {
          if (isRestricted(node.source.value)) context.report({ node, message })
        },
      }
    },
  }
}

function restrictedSyntax(message, selector) {
  return {
    meta: { type: 'problem', docs: { description: message }, schema: [] },
    create(context) {
      return {
        [selector](node) {
          context.report({ node, message })
        },
      }
    },
  }
}

const localPlugin = {
  rules: {
    // Row 1: lib/** must not import from app/**.
    'no-app-import-in-lib': restrictedImport(
      'lib/** must not import from app/** (ARCHITECTURE.md §2).',
      (source) => APP_IMPORT_RE.test(source),
    ),
    // Row 2: only lib/config.ts reads the process environment directly.
    'process-env-outside-config': restrictedSyntax(
      'Only lib/config.ts reads the process environment directly (ARCHITECTURE.md §2, §8).',
      "MemberExpression[object.name='process'][property.name='env']",
    ),
    // Row 3: only lib/db/client.ts imports @supabase/supabase-js.
    'supabase-js-outside-client': restrictedImport(
      'Only lib/db/client.ts imports @supabase/supabase-js (ARCHITECTURE.md §2).',
      (source) => source === '@supabase/supabase-js',
    ),
    // Row 4: only lib/audit/events.ts writes audit_events.
    'audit-events-outside-events': restrictedSyntax(
      'Only lib/audit/events.ts writes audit_events (ARCHITECTURE.md §2, SEC-4).',
      "Identifier[name='audit_events'], Literal[value='audit_events']",
    ),
    // Row 5: only lib/notify/email.ts imports the Resend SDK.
    'resend-outside-email': restrictedImport(
      'Only lib/notify/email.ts imports the Resend SDK (ARCHITECTURE.md §2, GAP-3).',
      (source) => source === 'resend',
    ),
    // Row 6: every app/api/** file imports lib/access/guard.ts or is
    // explicitly allowlisted as non-PHI. Not import-shaped like the other
    // rows — no-restricted-imports only forbids, this one requires — so it
    // walks the whole file's imports and reports once at Program:exit.
    'require-guard-import': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Every app/api/** file must import lib/access/guard.ts or appear in the allowlist (ARCHITECTURE.md §2, §5).',
        },
        schema: [
          {
            type: 'object',
            properties: {
              allowlist: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const allowlist = (context.options[0] && context.options[0].allowlist) || []
        const relativePath = path.relative(context.cwd, context.filename).split(path.sep).join('/')

        if (allowlist.includes(relativePath)) return {}

        let hasGuardImport = false

        return {
          ImportDeclaration(node) {
            const source = node.source.value
            if (source === '@/lib/access/guard' || GUARD_IMPORT_RE.test(source)) {
              hasGuardImport = true
            }
          },
          'Program:exit'(node) {
            if (!hasGuardImport) {
              context.report({
                node,
                message: `${relativePath} is under app/api/** and must import lib/access/guard.ts, or be added to GUARD_ALLOWLIST in eslint.config.mjs (ARCHITECTURE.md §2, §5).`,
              })
            }
          },
        }
      },
    },
    // Row 7: only lib/imaging/signing.ts mints signed Storage URLs.
    'signing-outside-signing': restrictedSyntax(
      'Only lib/imaging/signing.ts mints signed Storage URLs (ARCHITECTURE.md §2).',
      "CallExpression[callee.property.name='createSignedUrl']",
    ),
    // Row 8: lib/reports/ReportView.tsx is the only report renderer. Not
    // import-shaped — it inspects declaration/export names, not sources.
    'no-report-view-elsewhere': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Only lib/reports/ReportView.tsx may declare or export a component whose name ends in ReportView (ARCHITECTURE.md §2, FR-7/FR-8).',
        },
        schema: [],
      },
      create(context) {
        function reportIfReportViewName(node, name) {
          if (REPORT_VIEW_NAME_RE.test(name)) {
            context.report({
              node,
              message: `"${name}" ends in "ReportView" — only lib/reports/ReportView.tsx may declare or export a report renderer (ARCHITECTURE.md §2, FR-7/FR-8).`,
            })
          }
        }

        return {
          FunctionDeclaration(node) {
            if (node.id) reportIfReportViewName(node, node.id.name)
          },
          ClassDeclaration(node) {
            if (node.id) reportIfReportViewName(node, node.id.name)
          },
          VariableDeclarator(node) {
            if (node.id.type === 'Identifier') reportIfReportViewName(node, node.id.name)
          },
          ExportSpecifier(node) {
            const exportedName =
              node.exported.type === 'Identifier' ? node.exported.name : String(node.exported.value)
            reportIfReportViewName(node, exportedName)
          },
        }
      },
    },
  },
}

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // next-env.d.ts is Next.js-generated and carries a note not to hand-edit
    // it; its triple-slash reference is the framework's own boilerplate, not
    // something this repo authored, so it is excluded rather than the
    // @typescript-eslint/triple-slash-reference rule weakened project-wide.
    ignores: [
      '.next/**',
      '.worktrees/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
      // Planted violations for tests/lint/forbidden-imports.test.ts — linted
      // in-process against a scoped fixture root, never against this tree.
      'tests/lint/fixtures/**',
    ],
  },
  {
    // An eslint-disable comment cannot silence any of the eight rows below:
    // inline configuration comments are ignored outright across the module
    // tree these rows govern, so a suppressed line still reports.
    files: MODULE_TREE,
    linterOptions: { noInlineConfig: true },
  },
  {
    files: ['lib/**/*.ts', 'lib/**/*.tsx'],
    plugins: { local: localPlugin },
    rules: { 'local/no-app-import-in-lib': 'error' },
  },
  {
    files: MODULE_TREE,
    ignores: ['lib/config.ts'],
    plugins: { local: localPlugin },
    rules: { 'local/process-env-outside-config': 'error' },
  },
  {
    files: MODULE_TREE,
    ignores: ['lib/db/client.ts'],
    plugins: { local: localPlugin },
    rules: { 'local/supabase-js-outside-client': 'error' },
  },
  {
    files: MODULE_TREE,
    ignores: ['lib/audit/events.ts'],
    plugins: { local: localPlugin },
    rules: { 'local/audit-events-outside-events': 'error' },
  },
  {
    files: MODULE_TREE,
    ignores: ['lib/notify/email.ts'],
    plugins: { local: localPlugin },
    rules: { 'local/resend-outside-email': 'error' },
  },
  {
    files: ['app/api/**/*.ts', 'app/api/**/*.tsx'],
    plugins: { local: localPlugin },
    rules: { 'local/require-guard-import': ['error', { allowlist: GUARD_ALLOWLIST }] },
  },
  {
    files: MODULE_TREE,
    ignores: ['lib/imaging/signing.ts'],
    plugins: { local: localPlugin },
    rules: { 'local/signing-outside-signing': 'error' },
  },
  {
    files: MODULE_TREE,
    ignores: ['lib/reports/ReportView.tsx'],
    plugins: { local: localPlugin },
    rules: { 'local/no-report-view-elsewhere': 'error' },
  },
]

export default eslintConfig
