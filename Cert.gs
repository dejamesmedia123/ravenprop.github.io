/** Public certificate check. Add as a new file in Apps Script (Cert.gs). Returns only masked, non-sensitive facts.
 *  Phase certificates stay valid after the trader moves on: a challenge that is now in Phase 2
 *  has passed Phase 1, and a funded challenge has passed everything. */
function cert_verify(p) {
  p = p || {};
  var id = String(p.challenge_id || "").trim();
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) return { valid: false };
  var c = null;
  try { c = sheet_getByKey("Challenges", id); } catch (e) { return { valid: false }; }
  if (!c) return { valid: false };
  var stage = String(c.stage || ""), status = String(c.status || "");
  var funded = !!c.funded_at || stage === "Funded";
  var passedPhase = "";
  if (!funded) {
    if (stage === "Phase 2") passedPhase = status === "Passed" ? "Phase 2" : "Phase 1";
    else if (stage === "Phase 1" && status === "Passed") passedPhase = "Phase 1";
    else return { valid: false };
  }
  var u = {};
  try { u = sheet_getByKey("Users", c.user_id) || {}; } catch (e) {}
  return {
    valid: true,
    type: funded ? "funded" : "phase",
    passed_phase: passedPhase,
    stage: stage,
    status: status,
    plan_id: c.plan_id,
    account_size_usd: c.account_size_usd,
    date: funded ? String(c.funded_at || "").slice(0, 10) : "",
    trader: String(u.full_name || u.name || "").split(/\s+/).filter(String).map(function (w) { return w.charAt(0).toUpperCase() + "***"; }).join(" ")
  };
}
