/**
 * Finance.gs  (separate file, used only by finance.html)
 *
 * Adds three things the Finance page could not do before:
 *
 *  1. Edit gateway secret keys held in Script Properties
 *     (admin.finance.props.get / admin.finance.props.set)
 *  2. Rename a promo code (admin.finance.promo.rename)
 *     Everything else about a promo is still edited through admin.promo.save.
 *  3. Add / change / delete USDT receiving addresses as admin or owner
 *     (admin.finance.address.save / admin.finance.address.delete)
 *
 * Safety rules built in:
 *  - Only a fixed whitelist of keys can be written. Setup keys, EQUITY_SECRET,
 *    SPREADSHEET_ID, OWNER_EMAIL and the rest are untouchable from the browser.
 *  - Secret values are write-only. They are never returned, logged or audited.
 *    The page only learns "present / missing" and the last 4 characters.
 *  - Every write needs the signed-in person's password again.
 *  - Every change is written to the AuditLog (key name only, never the value).
 */

var FIN_EDITABLE_PROPS_ = {
  SQUAD_SECRET_KEY: { gateway: "squad", secret: true, min: 10 },
  FLW_SECRET_KEY: { gateway: "flutterwave", secret: true, min: 10 },
  MONNIFY_API_KEY: { gateway: "monnify", secret: true, min: 6 },
  MONNIFY_SECRET_KEY: { gateway: "monnify", secret: true, min: 6 },
  MONNIFY_CONTRACT_CODE: { gateway: "monnify", secret: false, min: 3 },
  MONNIFY_ENV: { gateway: "monnify", secret: false, enum: ["sandbox", "live"] }
};

function fin_bad_(m) {
  return util_error_(CODES.BAD_REQUEST, m);
}

function fin_requireAdmin_(ctx) {
  pay_requireAdmin_(ctx);
}

/** Ask for the signed-in person's password again before anything sensitive. */
function fin_confirmPassword_(payload, ctx) {
  var user = sheet_getByKey("Users", ctx.user.user_id);
  if (!user) throw util_error_(CODES.FORBIDDEN, "Account not found.");
  // Google-only accounts have no password to check; the live session is the proof.
  if (String(user.password_hash || "").indexOf("google$") === 0) return;
  var pw = payload && typeof payload.confirm_password === "string" ? payload.confirm_password : "";
  if (!pw || pw.length > 128 || !util_verifyPassword_(pw, user.password_hash)) {
    throw util_error_(CODES.FORBIDDEN, "Your password is incorrect. Nothing was changed.");
  }
}

function fin_mask_(value) {
  var v = String(value || "");
  return v ? "\u2022\u2022\u2022\u2022" + v.slice(-4) : "";
}

/** Which editable properties exist. Values are never returned. */
function fin_propsGet(payload, ctx) {
  fin_requireAdmin_(ctx);
  var store = PropertiesService.getScriptProperties();
  var props = Object.keys(FIN_EDITABLE_PROPS_).map(function (key) {
    var def = FIN_EDITABLE_PROPS_[key];
    var value = String(store.getProperty(key) || "");
    return {
      key: key,
      gateway: def.gateway,
      secret: def.secret,
      present: !!value,
      preview: def.secret ? fin_mask_(value) : value,
      allowed: def.enum || null
    };
  });
  return { properties: props };
}

/**
 * payload: { changes: { KEY: "new value" | null }, confirm_password }
 * null or "" removes the key. Only whitelisted keys are accepted.
 */
function fin_propsSet(payload, ctx) {
  fin_requireAdmin_(ctx);
  payload = payload || {};
  var changes = payload.changes && typeof payload.changes === "object" ? payload.changes : null;
  if (!changes || !Object.keys(changes).length) throw fin_bad_("Nothing to change.");
  if (Object.keys(changes).length > 10) throw fin_bad_("Too many changes at once.");

  // Validate everything before touching anything.
  var clean = {};
  Object.keys(changes).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(FIN_EDITABLE_PROPS_, key)) {
      throw fin_bad_(key + " cannot be changed from here.");
    }
    var def = FIN_EDITABLE_PROPS_[key];
    var raw = changes[key];
    if (raw === null || raw === "") {
      clean[key] = null;
      return;
    }
    if (typeof raw !== "string") throw fin_bad_(key + " must be text.");
    var v = raw.trim();
    if (/[\u0000-\u001F\s]/.test(v)) throw fin_bad_(key + " must not contain spaces or line breaks.");
    if (v.length > 300) throw fin_bad_(key + " is too long.");
    if (def.min && v.length < def.min) throw fin_bad_(key + " looks too short. Copy it again from the provider dashboard.");
    if (def.enum && def.enum.indexOf(v) === -1) throw fin_bad_(key + " must be one of: " + def.enum.join(", ") + ".");
    clean[key] = v;
  });

  fin_confirmPassword_(payload, ctx);

  return util_withLock_(function () {
    var store = PropertiesService.getScriptProperties();
    var audit = [];
    Object.keys(clean).forEach(function (key) {
      var had = !!store.getProperty(key);
      if (clean[key] === null) {
        if (!had) return;
        store.deleteProperty(key);
        audit.push({ action: "props.remove", entity: "ScriptProperties", id: key, field: "value", o: "(set)", n: "(removed)" });
      } else {
        store.setProperty(key, clean[key]);
        audit.push({ action: had ? "props.update" : "props.add", entity: "ScriptProperties", id: key, field: "value", o: had ? "(set)" : "(missing)", n: "(set)" });
      }
    });
    if (audit.length) settings_auditMany_(ctx, audit);
    try { settings_clear_(); } catch (e) {}
    var out = fin_propsGet({}, ctx);
    out.changed = audit.length;
    return out;
  });
}

/**
 * Rename a promo code, keeping its percent, limits, note and used count.
 * payload: { code, new_code }
 */
function fin_promoRename(payload, ctx) {
  fin_requireAdmin_(ctx);
  payload = payload || {};
  var oldCode = fx_promoNorm_(payload.code);
  var newCode = fx_promoNorm_(payload.new_code);
  if (!oldCode) throw fin_bad_("The current code is not valid.");
  if (!newCode) throw fin_bad_("The new code must be 3-20 letters, numbers, dashes or underscores.");
  if (oldCode === newCode) throw fin_bad_("The new code is the same as the old one.");

  return util_withLock_(function () {
    var row = sheet_getByKey("PromoCodes", oldCode);
    if (!row) throw fin_bad_("Promo code not found.");
    if (sheet_getByKey("PromoCodes", newCode)) throw fin_bad_("A promo code named " + newCode + " already exists.");

    var now = util_nowIso_();
    sheet_appendRow("PromoCodes", {
      code: newCode,
      percent_off: row.percent_off,
      status: row.status,
      expires_at: row.expires_at,
      usage_limit: row.usage_limit,
      used_count: row.used_count || 0,
      note: row.note,
      created_at: row.created_at || now,
      updated_at: now
    });
    sheet_deleteWhere("PromoCodes", { code: oldCode });
    settings_audit_(ctx, "promo.rename", "PromoCodes", newCode, "code", oldCode, newCode);
    return { promos: fx_promos_() };
  });
}

/**
 * Add or change a receiving address. Unlike admin.addresses.save, admins may
 * change the address itself, not only the note and the on/off switch.
 * payload: { address_id?, coin, network, address, note, active, confirm_password }
 * Changing or adding the wallet address needs the password again.
 */
function fin_addressSave(payload, ctx) {
  fin_requireAdmin_(ctx);
  payload = payload || {};
  var existing = payload.address_id ? sheet_getByKey("ReceivingAddresses", String(payload.address_id)) : null;
  if (payload.address_id && !existing) throw fin_bad_("Address not found.");

  var touchesWallet = !existing || ["coin", "network", "address"].some(function (f) {
    return payload[f] !== undefined && String(payload[f]).trim().toUpperCase() !== String(existing[f]).toUpperCase();
  });
  if (touchesWallet) fin_confirmPassword_(payload, ctx);

  // crypto_saveAddresses normally lets only the owner touch coin/network/address.
  // This server-built context flag (never read from the request) allows finance edits
  // and keeps the real role in the audit log.
  var elevated = { user: ctx.user, role: ctx.role, token: ctx.token, action: ctx.action, financeEdit: true };
  var out = crypto_saveAddresses({
    address_id: payload.address_id,
    coin: payload.coin,
    network: payload.network,
    address: payload.address,
    note: payload.note,
    active: payload.active
  }, elevated);

  if (touchesWallet) {
    settings_audit_(ctx, "address.finance_edit", "ReceivingAddresses",
      (out.address && out.address.address_id) || "", "address",
      existing ? existing.address : "", out.address ? out.address.address : "",
      "Wallet changed from the Finance page");
  }
  return out;
}

/** Delete a receiving address that no open order is using. payload: { address_id, confirm_password } */
function fin_addressDelete(payload, ctx) {
  fin_requireAdmin_(ctx);
  payload = payload || {};
  var id = String(payload.address_id || "");
  var row = id ? sheet_getByKey("ReceivingAddresses", id) : null;
  if (!row) throw fin_bad_("Address not found.");
  fin_confirmPassword_(payload, ctx);

  return util_withLock_(function () {
    var open = sheet_findRows("Payments", function (p) {
      return p.pay_address === row.address &&
        (p.status === "awaiting_payment" || p.status === "awaiting_confirmation");
    });
    if (open.length) {
      throw fin_bad_(open.length + " open order(s) are still using this address. Switch it off instead, then delete it once they are done.");
    }
    sheet_deleteWhere("ReceivingAddresses", { address_id: id });
    settings_audit_(ctx, "address.delete", "ReceivingAddresses", id, "address", row.address, "");
    return { addresses: crypto_addressList_().map(crypto_addrOut_) };
  });
}
