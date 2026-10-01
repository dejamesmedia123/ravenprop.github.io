/* Migrate.gs: one-click migration for a deployed system (admin > Settings > "Run migration", owner only).

   HOW IT WORKS
   - Every change that touches DATA already in the live sheet (plan values, settings, new columns)
     gets an entry in MIGRATIONS_ below. Changing only the seed in Code.gs is NOT enough for a live system,
     because seeds run once, when the spreadsheet is first built.
   - Each entry runs once and is remembered in Script Property MIGRATIONS_DONE. Running again is safe.
   - The button shows how many entries are pending, and lists them before it runs.
   - Never edit or reorder an entry that has already shipped. Add a new one at the bottom instead.

   ADDING A MIGRATION: append { id: "YYYY-MM-DD-short-name", note: "what it does", run: function (ctx) { ...; return "what changed"; } }
   run() must be idempotent and return a short text for the report. */
var MIGRATIONS_ = [
  {
    id: "2026-09-30-starter-payout-cap-10",
    note: "Starter plan: max payout 10% of account size",
    run: function (ctx) {
      var p = sheet_getByKey("ChallengePlans", "starter-500");
      if (!p) return "Starter plan (starter-500) not found, skipped";
      if (Number(p.payout_cap) === 10) return "Starter payout cap already 10%";
      admin_plansSave({ plan: { plan_id: "starter-500", payout_cap: 10 } }, ctx);
      return "Starter payout cap changed from " + p.payout_cap + "% to 10%";
    }
  },
  {
    id: "2026-09-30-starter-min-payout-5",
    note: "Starter plan: minimum payout 5% of account size, so a trader with $50 profit can withdraw",
    run: function (ctx) {
      var p = sheet_getByKey("ChallengePlans", "starter-500");
      if (!p) return "Starter plan (starter-500) not found, skipped";
      if (Number(p.min_payout_pct) === 5) return "Starter minimum payout already 5%";
      admin_plansSave({ plan: { plan_id: "starter-500", min_payout_pct: 5 } }, ctx);
      return "Starter minimum payout changed from " + p.min_payout_pct + "% to 5%";
    }
  },
  {
    id: "2026-10-01-starter-1000-plan",
    note: "Add the Starter 1,000 plan: $1,000 account for $7, can be bought again and again",
    run: function (ctx) {
      if (sheet_getByKey("ChallengePlans", "starter-1000")) return "Starter 1,000 plan (starter-1000) already exists, skipped";
      admin_plansSave({ plan: {
        plan_id: "starter-1000", style: "Starter", account_size_usd: 1000, fee_usd: 7, no_promo: true,
        phase1_target: 10, phase2_target: 0, daily_drawdown: 3.5, daily_drawdown_funded: 3.5,
        max_drawdown: 7, max_drawdown_funded: 7, drawdown_type: "static",
        profit_split_tiers: [{ from: 1, pct: 70 }, { from: 4, pct: 80 }],
        min_payout_pct: 5, payout_gap_days: 7, payout_cap: 10, scale_up_rule: "",
        minimum_days: 0, time_limit_days: 0, inactivity_days: 30, inactivity_warning_days: 23,
        daily_reset_time: "00:00", daily_reset_tz: "UTC", sort_order: 101, status: "active"
      } }, ctx);
      return "Added Starter 1,000 plan: $1,000 account, $7 fee, 7% max drawdown, repeat purchase allowed";
    }
  },
  {
    id: "2026-10-01-starter-1000-max-dd-7",
    note: "Starter 1,000 plan: max drawdown 7% (static). The daily trailing limit follows at 3.5%",
    run: function (ctx) {
      var p = sheet_getByKey("ChallengePlans", "starter-1000");
      if (!p) return "Starter 1,000 plan (starter-1000) not found, skipped";
      if (Number(p.max_drawdown) === 7 && Number(p.max_drawdown_funded) === 7) return "Starter 1,000 max drawdown already 7%";
      var was = p.max_drawdown;
      admin_plansSave({ plan: { plan_id: "starter-1000", max_drawdown: 7, max_drawdown_funded: 7, daily_drawdown: 3.5, daily_drawdown_funded: 3.5 } }, ctx);
      return "Starter 1,000 max drawdown changed from " + was + "% to 7%";
    }
  }
];

function migrate_done_() {
  try {
    var a = JSON.parse(PropertiesService.getScriptProperties().getProperty("MIGRATIONS_DONE") || "[]");
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

function migrate_pending_() {
  var done = migrate_done_();
  return MIGRATIONS_.filter(function (m) { return done.indexOf(m.id) < 0; });
}

function admin_migrate(e, ctx) {
  if (!ctx || !ctx.user || ctx.role !== "owner") {
    throw util_error_(CODES.FORBIDDEN, "Only the owner can run a migration.");
  }
  e = e || {};
  if (e.check) {
    return {
      pending: migrate_pending_().map(function (m) { return { id: m.id, note: m.note || m.id }; }),
      applied: migrate_done_()
    };
  }
  return util_withLock_(function () {
    var steps = [];
    var b = sheet_buildAll_();
    settings_clear_();
    if (b.created.length) steps.push("Created sheets: " + b.created.join(", "));
    Object.keys(b.addedColumns).forEach(function (k) {
      steps.push("Added columns to " + k + ": " + b.addedColumns[k].join(", "));
    });
    Object.keys(b.seeded).forEach(function (k) {
      steps.push("Added " + b.seeded[k] + " missing row(s) to " + k);
    });
    if (!steps.length) steps.push("Sheets and settings already up to date");

    var done = migrate_done_();
    MIGRATIONS_.forEach(function (m) {
      if (done.indexOf(m.id) >= 0) return;
      steps.push(m.run(ctx));
      done.push(m.id);
      PropertiesService.getScriptProperties().setProperty("MIGRATIONS_DONE", JSON.stringify(done));
    });
    settings_clear_();
    settings_audit_(ctx, "system.migrate", "System", "", "", "", JSON.stringify(steps).slice(0, 900));
    return { steps: steps, applied: done, pending: [] };
  });
}
