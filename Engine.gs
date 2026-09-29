// =====================================================================
// RAVEN PROP BACKEND: Engine.gs
// Exchange rates and quotes (Part 7 built), MT5 account pool (Part 8 built), rules engine (Part 9 built), challenge
// lifecycle (Part 10 built). Parts 7-10. Prefixes: fx_, pool_, rules_, chal_.
// =====================================================================

// ===== PART 7: EXCHANGE RATES AND FEE QUOTES (minified; top-level names kept) =====
var FX_TV_URL_="https://scanner.tradingview.com/forex/scan",FX_PROMO_ERR_="This promo code is invalid or has expired.";
function fx_bad_(e){return util_error_(CODES.BAD_REQUEST,e)}
function fx_ccy_(e){return typeof e=="string"&&/^[A-Za-z]{3}$/.test(e.trim())?e.trim().toUpperCase():null}
function fx_ageMin_(e){var n=e.fetched_at?Date.parse(e.fetched_at):NaN;return isFinite(n)?Math.max(0,Math.round((Date.now()-n)/6e4)):null}
function fx_isFresh_(e){var n=e.fetched_at?Date.parse(e.fetched_at):NaN;return isFinite(n)&&Date.now()-n<Number(settings_get("fx_cache_hours",24))*36e5}
function fx_pause_(){try{CacheService.getScriptCache().put("fx_fail","1",600)}catch{}}
function fx_resume_(){try{CacheService.getScriptCache().remove("fx_fail")}catch{}}
function fx_paused_(){try{return!!CacheService.getScriptCache().get("fx_fail")}catch{return!1}}
function fx_fetchLive_(e){var n={symbols:{tickers:e.map(function(i){return"FX_IDC:USD"+i})},columns:["close"]},t=UrlFetchApp.fetch(FX_TV_URL_,{method:"post",contentType:"application/json",payload:JSON.stringify(n),muteHttpExceptions:!0});if(t.getResponseCode()!==200)throw new Error("TradingView HTTP "+t.getResponseCode());var a=JSON.parse(t.getContentText()),o={};return(a.data||[]).forEach(function(i){var u=String(i.s||"").replace("FX_IDC:USD",""),r=i.d&&Number(i.d[0]);r>0&&isFinite(r)&&(o[u]=r)}),o}
function fx_refresh(e){var n=sheet_readAll("FxRates").filter(function(r){return r.mode==="live"&&r.currency!=="USD"&&(e||!fx_isFresh_(r))}),t=[],i=[],a="";if(!n.length)return{updated:t,failed:i,error:a};if(!e&&fx_paused_())return{updated:t,failed:n.map(function(r){return r.currency}),error:"retry_paused"};var o=null;try{o=fx_fetchLive_(n.map(function(r){return r.currency}))}catch(r){a=String(r&&r.message||r)}var u=util_nowIso_(),l=[];return n.forEach(function(r){var c=o&&o[r.currency],f=String(r.source||"");if(c>0)l.push({target:r,changes:{rate:c,source:"tradingview",fetched_at:u}}),t.push(r.currency);else if(i.push(r.currency),r.rate>0){/_stale$|^admin_fallback$/.test(f)||l.push({target:r,changes:{source:(f||"last")+"_stale"}})}else r.fallback_rate>0&&l.push({target:r,changes:{rate:r.fallback_rate,source:"admin_fallback"}})}),l.length&&sheet_updateRows("FxRates",l),i.length?fx_pause_():fx_resume_(),{updated:t,failed:i,error:a}}
function fx_getRate(e){var n=fx_ccy_(e);if(!n)throw fx_bad_("Invalid currency.");if(n==="USD")return{currency:"USD",rate:1,markup_pct:0,mode:"manual",source:"fixed",age_minutes:0};var t=sheet_getByKey("FxRates",n);if(!t)throw fx_bad_("No exchange rate is set for "+n+".");if(t.mode==="live"&&!fx_isFresh_(t)){try{fx_refresh(!1)}catch(o){console.error("fx_refresh: "+o)}t=sheet_getByKey("FxRates",n)}var i=t.rate>0?t.rate:t.fallback_rate>0?t.fallback_rate:0;if(!(i>0))throw fx_bad_("No exchange rate is available for "+n+".");var a=t.markup_pct!=null?t.markup_pct:t.mode==="live"?Number(settings_get("fx_markup_pct_default",2)):0;return{currency:n,rate:i,markup_pct:a,mode:t.mode,source:t.source||"",age_minutes:fx_ageMin_(t)}}
function fx_promoNorm_(e){return typeof e=="string"&&/^[A-Za-z0-9_-]{3,20}$/.test(e.trim())?e.trim().toUpperCase():null}
function fx_promoCheck_(e){var n=util_error_(CODES.BAD_REQUEST,FX_PROMO_ERR_),t=fx_promoNorm_(e);if(!t)throw n;var i=sheet_getByKey("PromoCodes",t);if(!i||i.status!=="active"||!(i.percent_off>0)||i.expires_at&&!(Date.parse(i.expires_at)>Date.now())||i.usage_limit>0&&(i.used_count||0)>=i.usage_limit)throw n;return i}
function fx_promoTake_(e){var n=fx_promoCheck_(e);sheet_updateRow("PromoCodes",n,{used_count:(n.used_count||0)+1,updated_at:util_nowIso_()})}
function fx_promoRelease_(e){var n=fx_promoNorm_(e);n&&util_withLock_(function(){var t=sheet_getByKey("PromoCodes",n);t&&t.used_count>0&&sheet_updateRow("PromoCodes",t,{used_count:t.used_count-1,updated_at:util_nowIso_()})})}
function fx_getFeeQuote(e,n,t){var i=typeof e=="string"?settings_getPlan(e):null;if(!i||i.status!=="active")throw fx_bad_("This plan is not available.");var a=util_normalizeCountry_(n),o=a&&settings_getCountry(a);if(!o||!o.enabled)throw fx_bad_("Payments are not available in this country.");var u=util_roundMoney_(i.fee_usd),l=0,r="",c=!1,f=Math.max(Number(settings_get("fee_floor_usd",10)),Number(settings_get("min_crypto_usd",10))),s=typeof t=="string"?t.trim():t;if(s!=null&&s!==""){var d=fx_promoCheck_(s);r=d.code,l=util_pctOf_(u,d.percent_off),u-l<f&&(l=util_roundMoney_(Math.max(0,u-f)),c=!0)}var m=util_roundMoney_(u-l),rt=gw_getPaymentRoute(a),p=fx_getRate(rt.currency),h=util_convertUsd_(m,p.rate,p.markup_pct);return{plan_id:i.plan_id,style:i.style,account_size_usd:i.account_size_usd,country:a,currency:rt.currency,gateway:rt.gateway,list_fee_usd:u,promo_code:r,discount_usd:l,promo_capped:c,amount_usd:m,rate:h.rate,markup_pct:h.markupPct,local_amount:h.local,rate_source:p.source,valid_minutes:Number(settings_get("quote_validity_minutes",30))}}
function fx_pubQuote_(e){var n={};return["plan_id","style","account_size_usd","country","currency","list_fee_usd","promo_code","discount_usd","promo_capped","amount_usd","rate","markup_pct","local_amount","valid_minutes"].forEach(function(t){n[t]=e[t]}),n}
function fx_previewQuote(e,n){e=e||{};return fx_pubQuote_(fx_getFeeQuote(e.plan_id,e.country,e.promo_code))}
function fx_quoteOut_(e){return{order_ref:e.order_ref,plan_id:e.plan_id,country:e.country,currency:e.currency,list_fee_usd:e.list_fee_usd,promo_code:e.promo_code,discount_usd:e.discount_usd,amount_usd:e.amount_usd,local_amount:e.local_amount,rate:e.rate_used,markup_pct:e.markup_pct,expires_at:e.quote_expires_at,status:e.status}}
function fx_saveQuote(e,n){if(n=n||{},!e)throw util_error_(CODES.UNAUTHENTICATED,"Please log in.");if(!settings_get("payments_enabled",!0))throw util_error_(CODES.BUSY,"Payments are paused. Please try again later.");var t=fx_getFeeQuote(n.plan_id,n.country,n.promo_code);return util_withLock_(function(){t.promo_code&&fx_promoTake_(t.promo_code);try{var i=Date.now(),a=util_newOrderRef_(function(u){return!!sheet_getByKey("Payments",u)}),o=new Date(i).toISOString();return fx_quoteOut_(sheet_appendRow("Payments",{order_ref:a,user_id:e,plan_id:t.plan_id,gateway:t.gateway,country:t.country,list_fee_usd:t.list_fee_usd,promo_code:t.promo_code,discount_usd:t.discount_usd,amount_usd:t.amount_usd,currency:t.currency,local_amount:t.local_amount,rate_used:t.rate,markup_pct:t.markup_pct,quote_expires_at:new Date(i+t.valid_minutes*6e4).toISOString(),status:"created",status_history:[{status:"created",at:o}],created_at:o,updated_at:o}))}catch(i){throw t.promo_code&&fx_promoRelease_(t.promo_code),i}})}
function fx_quoteExpired_(e){return!(Date.parse(e.quote_expires_at)>Date.now())}
function fx_checkQuote(e,n,t){var i=typeof n=="number"?n:typeof n=="string"&&n.trim()!==""?Number(n):NaN;return!e||!isFinite(i)?{ok:!1,reason:"Invalid amount."}:String(t||"").toUpperCase()!==String(e.currency).toUpperCase()?{ok:!1,reason:"Currency does not match the quote."}:util_toCents_(i)!==util_toCents_(e.local_amount)?{ok:!1,reason:"Amount does not match the quote."}:{ok:!0,reason:""}}
function fx_list_(){return sheet_readAll("FxRates").map(function(e){return{currency:e.currency,rate:e.rate,mode:e.mode,source:e.source,fetched_at:e.fetched_at,age_minutes:fx_ageMin_(e),markup_pct:e.markup_pct,fallback_rate:e.fallback_rate}})}
function fx_promos_(){return sheet_readAll("PromoCodes").map(function(e){return{code:e.code,percent_off:e.percent_off,status:e.status,expires_at:e.expires_at,usage_limit:e.usage_limit,used_count:e.used_count,note:e.note}})}
function admin_fxSave(e,n){if(e=e||{},e.refresh){var t=fx_refresh(!0);return settings_audit_(n,"fx.refresh","FxRates","all"),{rates:fx_list_(),refresh:t}}if(!e.currency)return{rates:fx_list_()};var i=fx_ccy_(e.currency);if(!i||i==="USD")throw fx_bad_("Enter a currency code other than USD.");return util_withLock_(function(){var a=sheet_getByKey("FxRates",i),o={},u=util_nowIso_(),l=[];if(e.mode!==void 0){if(e.mode!=="live"&&e.mode!=="manual")throw fx_bad_("mode must be live or manual.");o.mode=e.mode}if(e.rate!==void 0){var r=Number(e.rate);if(typeof e.rate=="boolean"||!(r>0)||!isFinite(r))throw fx_bad_("rate must be a number above 0.");o.rate=r,o.source="owner_manual"}if(e.markup_pct!==void 0)if(e.markup_pct===""||e.markup_pct===null)o.markup_pct="";else{var c=Number(e.markup_pct);if(typeof e.markup_pct=="boolean"||!(c>=0&&c<=100))throw fx_bad_("markup_pct must be between 0 and 100.");o.markup_pct=c}if(e.fallback_rate!==void 0)if(e.fallback_rate===""||e.fallback_rate===null)o.fallback_rate="";else{var f=Number(e.fallback_rate);if(typeof e.fallback_rate=="boolean"||!(f>0)||!isFinite(f))throw fx_bad_("fallback_rate must be a number above 0.");o.fallback_rate=f}var s=o.mode||(a?a.mode:"live");if((o.rate>0||a&&o.mode==="live"&&a.mode!=="live")&&(o.fetched_at=s==="live"?"":u),a)Object.keys(o).forEach(function(d){d!=="fetched_at"&&String(a[d]==null?"":a[d])!==String(o[d])&&l.push({action:"fx.update",entity:"FxRates",id:i,field:d,o:a[d],n:o[d]})}),Object.keys(o).length&&sheet_updateRow("FxRates",a,o);else{if(!(o.rate>0)&&!(o.fallback_rate>0))throw fx_bad_("A new currency needs a rate or a fallback rate.");var m=Object.assign({currency:i,mode:"live"},o);o.rate>0||(m.rate=o.fallback_rate,m.source="admin_fallback"),sheet_appendRow("FxRates",m),l.push({action:"fx.create",entity:"FxRates",id:i,n:m})}return l.length&&settings_auditMany_(n,l),{rates:fx_list_()}})}
function admin_promoSave(e,n){if(e=e||{},e.code===void 0)return{promos:fx_promos_()};var t=fx_promoNorm_(e.code);if(!t)throw fx_bad_("code must be 3-20 letters, numbers, dashes or underscores.");return util_withLock_(function(){var i=sheet_getByKey("PromoCodes",t),a={},o=util_nowIso_(),u=[];if(e.percent_off!==void 0){var l=Number(e.percent_off);if(typeof e.percent_off=="boolean"||!(l>0&&l<=100))throw fx_bad_("percent_off must be above 0 and at most 100.");a.percent_off=l}if(e.status!==void 0){if(e.status!=="active"&&e.status!=="disabled")throw fx_bad_("status must be active or disabled.");a.status=e.status}if(e.expires_at!==void 0)if(e.expires_at===""||e.expires_at===null)a.expires_at="";else{var r=typeof e.expires_at=="string"?Date.parse(e.expires_at):NaN;if(!isFinite(r))throw fx_bad_("expires_at must be a valid date.");a.expires_at=new Date(r).toISOString()}if(e.usage_limit!==void 0)if(e.usage_limit===""||e.usage_limit===null)a.usage_limit="";else{var c=Number(e.usage_limit);if(typeof e.usage_limit=="boolean"||!(c>=0&&Math.floor(c)===c))throw fx_bad_("usage_limit must be a whole number of 0 or more (0 or empty means unlimited).");a.usage_limit=c}if(e.note!==void 0){if(typeof e.note!="string"||e.note.length>200)throw fx_bad_("note must be text of up to 200 characters.");a.note=e.note}if(i)Object.keys(a).forEach(function(f){String(i[f]==null?"":i[f])!==String(a[f])&&u.push({action:"promo.update",entity:"PromoCodes",id:t,field:f,o:i[f],n:a[f]})}),Object.keys(a).length&&(a.updated_at=o,sheet_updateRow("PromoCodes",i,a));else{if(!(a.percent_off>0))throw fx_bad_("percent_off is required for a new promo code.");var s=Object.assign({code:t,status:"active",used_count:0,created_at:o,updated_at:o},a);sheet_appendRow("PromoCodes",s),u.push({action:"promo.create",entity:"PromoCodes",id:t,n:s})}return u.length&&settings_auditMany_(n,u),{promos:fx_promos_()}})}
function fx_runTests(){var e=SpreadsheetApp.create("RAVEN-FX-TEST"),n=[],t=fx_fetchLive_,i={user:{user_id:"U-T"},role:"owner"},a=0,o=function(){};function u(s,d){try{d()}catch(m){n.push(s+": "+m.message)}}function l(s,d){try{s()}catch(m){if(d&&m.message!==d)throw new Error("wrong message: "+m.message);return}throw new Error("should have failed")}function r(s){return sheet_getByKey("FxRates",s)}try{sheet_buildAll_(e),settings_clear_(),gw_testEnable_(["squad"]),u("ngn quote",function(){var s=fx_getFeeQuote("swift-10000","NG");util_assertEq_(s.local_amount,132000,"local"),util_assertEq_(s.currency,"NGN","ccy"),util_assertEq_(s.amount_usd,100,"usd")}),u("client price ignored",function(){var s=fx_previewQuote({plan_id:"swift-10000",country:"NG",fee_usd:1,amount_usd:1,local_amount:5,price:1},{});util_assertEq_(s.local_amount,132000,"local"),util_assert_(s.gateway===void 0&&s.rate_source===void 0,"no internals")}),u("router preview public",function(){var s=router_handle_({postData:{contents:JSON.stringify({action:"fx.previewQuote",payload:{plan_id:"apex-1000",country:"NG"}})}});util_assertEq_(s.ok,!0,"ok"),util_assertEq_(s.data.local_amount,39600,"apex 1000")}),u("bad inputs",function(){l(function(){fx_getFeeQuote("nope","NG")}),l(function(){fx_getFeeQuote("swift-10000","ZZ")}),l(function(){fx_getFeeQuote("swift-10000","US")}),l(function(){fx_getFeeQuote({},"NG")})}),u("manual never overwritten",function(){var s=[];fx_fetchLive_=function(d){return s.push(d),{GHS:16,NGN:999}},admin_fxSave({currency:"GHS",mode:"live",rate:15},i),fx_refresh(!0),util_assertEq_(r("NGN").rate,1320,"NGN kept"),util_assertEq_(r("NGN").source,"owner_manual","NGN source"),util_assertEq_(r("GHS").rate,16,"GHS live"),util_assertEq_(r("GHS").source,"tradingview","GHS source"),util_assert_(s.length===1&&s[0].indexOf("NGN")<0&&s[0].indexOf("USD")<0,"only live currencies fetched"),fx_refresh(!1),util_assertEq_(s.length,1,"cache respected")}),u("default markup on live",function(){sheet_updateRow("Countries","GH",{currency:"GHS"}),settings_clear_();var s=fx_getFeeQuote("swift-10000","GH");util_assertEq_(s.markup_pct,2,"markup"),util_assertEq_(s.local_amount,1632,"local")}),u("stale fallback + retry pause",function(){fx_resume_(),sheet_updateRow("FxRates","GHS",{fetched_at:"2000-01-01T00:00:00.000Z"}),fx_fetchLive_=function(){throw a++,new Error("down")};var s=fx_getRate("GHS");util_assertEq_(s.rate,16,"kept"),util_assertEq_(r("GHS").source,"tradingview_stale","stale tag"),fx_getRate("GHS"),util_assertEq_(a,1,"no retry while paused")}),u("admin fallback and missing",function(){admin_fxSave({currency:"KES",mode:"live",fallback_rate:130},i),util_assertEq_(fx_getRate("KES").rate,130,"fallback"),util_assertEq_(r("KES").source,"admin_fallback","source"),l(function(){fx_getRate("XYZ")}),l(function(){admin_fxSave({currency:"USD",rate:2},i)}),l(function(){admin_fxSave({currency:"EUR"},i)}),l(function(){admin_fxSave({currency:"EUR",rate:-1},i)})}),u("explicit markup on manual",function(){admin_fxSave({currency:"NGN",markup_pct:2},i),util_assertEq_(fx_getFeeQuote("swift-10000","NG").local_amount,134640,"marked up"),admin_fxSave({currency:"NGN",markup_pct:0},i),util_assertEq_(fx_getFeeQuote("swift-10000","NG").local_amount,132000,"reset");var s=sheet_findRows("AuditLog",{entity:"FxRates",field:"markup_pct"});util_assert_(s.length===2,"audited")}),u("promo",function(){admin_promoSave({code:"save20",percent_off:20},i);var s=fx_getFeeQuote("swift-10000","NG","save20");util_assertEq_(s.amount_usd,80,"usd"),util_assertEq_(s.local_amount,105600,"local"),util_assertEq_(s.discount_usd,20,"disc"),util_assertEq_(s.promo_code,"SAVE20","code"),util_assertEq_(fx_getFeeQuote("swift-10000","NG"," ").amount_usd,100,"blank promo")}),u("promo floor",function(){admin_promoSave({code:"BIG90",percent_off:90},i);var s=fx_getFeeQuote("swift-5000","NG","BIG90");util_assertEq_(s.amount_usd,10,"floor"),util_assertEq_(s.discount_usd,40,"disc"),util_assertEq_(s.promo_capped,!0,"capped"),s=fx_getFeeQuote("swift-1000","NG","BIG90"),util_assertEq_(s.amount_usd,10,"already at floor"),util_assertEq_(s.discount_usd,0,"no disc")}),u("promo invalid",function(){admin_promoSave({code:"OLD",percent_off:10,expires_at:"2000-01-01"},i),admin_promoSave({code:"OFF",percent_off:10,status:"disabled"},i),["OLD","OFF","NOPE","x",["A"]].forEach(function(s){l(function(){fx_getFeeQuote("swift-10000","NG",s)},FX_PROMO_ERR_)})}),u("save quote",function(){var s=fx_saveQuote("U-T",{plan_id:"swift-10000",country:"NG",promo_code:"SAVE20"}),d=sheet_getByKey("Payments",s.order_ref);util_assertEq_(d.amount_usd,80,"usd"),util_assertEq_(d.local_amount,105600,"local"),util_assertEq_(d.rate_used,1320,"rate"),util_assertEq_(d.status,"created","status"),util_assertEq_(d.user_id,"U-T","user");var m=Date.parse(d.quote_expires_at)-Date.now();util_assert_(m>29*6e4&&m<=30*6e4+1e3,"expires in 30 min"),util_assertEq_(sheet_getByKey("PromoCodes","SAVE20").used_count,1,"promo used"),util_assertEq_(fx_checkQuote(d,105600,"NGN").ok,!0,"match"),util_assertEq_(fx_checkQuote(d,"105600.00","ngn").ok,!0,"string ok"),util_assertEq_(fx_checkQuote(d,105599,"NGN").ok,!1,"low amount"),util_assertEq_(fx_checkQuote(d,105600,"USD").ok,!1,"wrong ccy"),util_assertEq_(fx_checkQuote(d,"abc","NGN").ok,!1,"junk"),util_assertEq_(fx_quoteExpired_(d),!1,"fresh"),sheet_updateRow("Payments",d,{quote_expires_at:"2000-01-01T00:00:00.000Z"}),util_assertEq_(fx_quoteExpired_(sheet_getByKey("Payments",s.order_ref)),!0,"expired")}),u("promo limit + release",function(){admin_promoSave({code:"ONCE",percent_off:10,usage_limit:1},i),fx_saveQuote("U-T",{plan_id:"swift-10000",country:"NG",promo_code:"ONCE"}),l(function(){fx_saveQuote("U-T",{plan_id:"swift-10000",country:"NG",promo_code:"ONCE"})},FX_PROMO_ERR_),fx_promoRelease_("ONCE"),util_assertEq_(sheet_getByKey("PromoCodes","ONCE").used_count,0,"released"),fx_saveQuote("U-T",{plan_id:"swift-10000",country:"NG",promo_code:"ONCE"})}),u("payments paused",function(){admin_settingsSet({changes:{payments_enabled:!1}},i),l(function(){fx_saveQuote("U-T",{plan_id:"swift-10000",country:"NG"})}),admin_settingsSet({changes:{payments_enabled:!0}},i)}),u("no user",function(){l(function(){fx_saveQuote("",{plan_id:"swift-10000",country:"NG"})})})}finally{fx_fetchLive_=t,fx_resume_(),sheet_setSpreadsheet_(null),settings_clear_();try{DriveApp.getFileById(e.getId()).setTrashed(!0)}catch{}}if(n.length)throw new Error("Failed: "+n.join(" | "));console.log("ALL PART 7 TESTS PASSED")}

// ===== PART 8: ACCOUNT POOL (minified; top-level names kept) =====
var POOL_STATUSES_=["Available","Assigned","Used"],POOL_MAX_ROWS_=500;
function pool_bad_(e){return util_error_(CODES.BAD_REQUEST,e)}
function pool_key_(){try{var e=PropertiesService.getScriptProperties().getProperty("POOL_ENC_KEY");return e&&e.length>=16?e:null}catch{return null}}
function pool_ks_(e,n,t){for(var i=[],a=0;i.length<t;a++)for(var o=Utilities.computeHmacSha256Signature(n+":"+a,e),u=0;u<o.length&&i.length<t;u++)i.push(o[u]&255);return i}
function pool_tag_(e,n,t){return util_hex_(Utilities.computeHmacSha256Signature("tag:"+n+":"+t,e).map(function(i){return i&255}))}
function pool_enc_(e,n){var t=util_randomHex_(16),i=util_utf8Bytes_(e),a=pool_ks_(n,t,i.length),o=util_hex_(i.map(function(u,l){return(u^a[l])&255}));return"enc1."+t+"."+o+"."+pool_tag_(n,t,o)}
function pool_dec1_(e,n){var t=String(e).split("."),i=util_error_(CODES.INTERNAL,"Stored account password could not be decrypted.");if(t.length!==4||t[0]!=="enc1"||!/^[0-9a-f]*$/.test(t[2])||!util_safeEqual_(t[3],pool_tag_(n,t[1],t[2])))throw i;for(var a=t[2].length/2,o=pool_ks_(n,t[1],a),u="",l=0;l<a;l++)u+="%"+("0"+((parseInt(t[2].substr(l*2,2),16)^o[l])&255).toString(16)).slice(-2);try{return decodeURIComponent(u)}catch{throw i}}
function pool_dec_(e){if(!e.encrypted)return e;var n=pool_key_();if(!n)throw util_error_(CODES.INTERNAL,"Pool passwords are encrypted but POOL_ENC_KEY is not set.");return Object.assign({},e,{password:pool_dec1_(e.password,n),investor_password:pool_dec1_(e.investor_password,n)})}
function pool_safe_(e){return{pool_id:e.pool_id,size_usd:e.size_usd,login:e.login,password:e.password,server:e.server}}
function pool_adminRow_(e){var n={};return["pool_id","size_usd","login","server","status","encrypted","assigned_to","challenge_id","assigned_at","used_at","imported_at","import_batch"].forEach(function(t){n[t]=e[t]}),n}
function pool_sizes_(){var e={};return settings_getPlans(!0).forEach(function(n){e[n.account_size_usd]=1}),Object.keys(e).map(Number)}
function pool_parseCsv_(e){var n=String(e||"").replace(/^\uFEFF/,""),t=n.split(/\r\n|\n|\r/,1)[0],i=t.indexOf("\t")>=0&&t.indexOf(",")<0?"\t":",",a=[],o=[],u="",l=!1,r=0,c;for(;r<n.length;r++)if(c=n.charAt(r),l)c==='"'?n.charAt(r+1)==='"'?(u+='"',r++):l=!1:u+=c;else if(c==='"')l=!0;else if(c===i)o.push(u),u="";else if(c==="\n"||c==="\r")c==="\r"&&n.charAt(r+1)==="\n"&&r++,o.push(u),u="",a.push(o),o=[];else u+=c;(u!==""||o.length)&&(o.push(u),a.push(o));var f=a.filter(function(v){return v.some(function(y){return y.trim()!==""})});if(!f.length)return[];var s={login:"login",password:"password",main_password:"password",investor_password:"investor_password",investor:"investor_password",investor_pass:"investor_password",server:"server",size:"size",size_usd:"size",account_size:"size"},d=f[0].map(function(v){return s[v.trim().toLowerCase().replace(/[\s-]+/g,"_")]||""});if(d.indexOf("login")<0)throw pool_bad_("The first CSV row must be a header: login,password,investor_password,server,size.");return f.slice(1).map(function(v,y){var m={_line:y+2};return d.forEach(function(h,p){h&&(m[h]=String(v[p]===void 0?"":v[p]).trim())}),m})}
function admin_poolImport(e,n){e=e||{};var t;if(typeof e.csv=="string"){if(e.csv.length>2e5)throw pool_bad_("The CSV is too large.");t=pool_parseCsv_(e.csv)}else if(Array.isArray(e.rows))t=e.rows.map(function(i,a){return Object.assign({},i&&typeof i=="object"?i:{},{_line:a+1})});else throw pool_bad_("Send csv text or a rows list.");if(!t.length)throw pool_bad_("Nothing to import.");if(t.length>POOL_MAX_ROWS_)throw pool_bad_("Import at most "+POOL_MAX_ROWS_+" accounts at a time.");return util_withLock_(function(){var i=pool_sizes_(),a=settings_get("pool_server_by_size",{})||{},o={},u={},l=[],r=[],c=[],f=util_nowIso_();sheet_readAll("AccountPool").forEach(function(v){o[v.login+"|"+String(v.server).toLowerCase()]=1,u[v.pool_id]=1}),t.forEach(function(v){var y=String(v.size!=null?v.size:v.size_usd!=null?v.size_usd:"").replace(/[$,\s]/g,""),m=v.server==null?"":String(v.server).trim();m||(m=String(a[y]||""));var h=util_validatePoolRow_({login:v.login,password:v.password,investor_password:v.investor_password,server:m,size:y},{allowedSizes:i});if(!h.ok){r.push({line:v._line,login:String(v.login==null?"":v.login).slice(0,20),errors:h.errors});return}var p=h.value,S=p.login+"|"+p.server.toLowerCase();if(o[S]){c.push({line:v._line,login:p.login,reason:o[S]===2?"repeated in this import":"already in the pool"});return}o[S]=2,l.push(p)});var s="IB-"+f.slice(0,10).replace(/-/g,"")+"-"+util_randomCode_(4),d={batch:s,total:t.length,valid:l.length,rejected:r,duplicates:c,imported:0,dry_run:!!e.dry_run,blocked:!1};if(e.dry_run||!l.length)return d;if((r.length||c.length)&&!e.skip_invalid)return d.blocked=!0,d;var m=pool_key_(),g=l.map(function(v){var y=util_newId_("P",function(h){return u[h]===1});return u[y]=1,{pool_id:y,size_usd:v.size,login:v.login,password:m?pool_enc_(v.password,m):v.password,investor_password:m?pool_enc_(v.investor_password,m):v.investor_password,server:v.server,status:"Available",encrypted:!!m,imported_at:f,import_batch:s}});return sheet_appendRows("AccountPool",g),d.imported=g.length,d.encrypted=!!m,settings_audit_(n,"pool.import","AccountPool",s,"count","",g.length,r.length+c.length+" rows skipped"),d})}
function pool_assign(e,n,t){var i=Number(e);if(!(i>0)||Math.floor(i)!==i)throw pool_bad_("Invalid account size.");if(typeof n!="string"||!n)throw pool_bad_("challenge_id is required.");return util_withLock_(function(){var a=sheet_readAll("AccountPool").filter(function(l){return l.status==="Available"&&l.size_usd===i}).sort(function(l,r){return(Date.parse(l.imported_at)||0)-(Date.parse(r.imported_at)||0)||l._row-r._row});if(!a.length){var o=util_error_(CODES.BUSY,"No account is available for this size right now.");throw o.outOfStock=!0,o}var u=pool_dec_(a[0]);return sheet_updateRow("AccountPool",a[0],{status:"Assigned",assigned_to:t||"",challenge_id:n,assigned_at:util_nowIso_()}),pool_safe_(u)})}
function pool_markUsed(e){return util_withLock_(function(){var n=typeof e=="string"?sheet_getByKey("AccountPool",e):null;if(!n)throw pool_bad_("Unknown pool account.");if(n.status==="Used")return{pool_id:e,status:"Used",already:!0};if(n.status!=="Assigned")throw pool_bad_("Only an assigned account can be marked used.");return sheet_updateRow("AccountPool",n,{status:"Used",used_at:util_nowIso_()}),{pool_id:e,status:"Used",already:!1}})}
function pool_stock(){var e=Number(settings_get("pool_low_stock_default",5)),n=settings_get("pool_low_stock_by_size",{})||{},t={};return isFinite(e)||(e=5),settings_getPlans(!0).forEach(function(i){var a=t[i.account_size_usd]||(t[i.account_size_usd]={size:i.account_size_usd,available:0,assigned:0,used:0,active:!1});i.status==="active"&&(a.active=!0)}),sheet_readAll("AccountPool").forEach(function(i){var a=t[i.size_usd]||(t[i.size_usd]={size:i.size_usd,available:0,assigned:0,used:0,active:!1});a[String(i.status).toLowerCase()]++}),Object.keys(t).map(Number).sort(function(i,a){return i-a}).map(function(i){var a=t[i],o=n[i]!=null&&isFinite(Number(n[i]))?Number(n[i]):e;return a.threshold=o,a.low=a.active&&a.available<=o,a})}
function pool_lowStock(){return pool_stock().filter(function(e){return e.low})}
function pool_monitorList(){return sheet_readAll("AccountPool").filter(function(e){return e.status==="Assigned"}).map(function(e){var n=pool_dec_(e);return{pool_id:n.pool_id,login:n.login,server:n.server,investor_password:n.investor_password}})}
function admin_poolList(e,n){if(e=e||{},e.status&&POOL_STATUSES_.indexOf(e.status)<0)throw pool_bad_("status must be one of: "+POOL_STATUSES_.join(", ")+".");var t=null;if(e.reveal_id){var i=typeof e.reveal_id=="string"?sheet_getByKey("AccountPool",e.reveal_id):null;if(!i)throw pool_bad_("Unknown pool account.");var a=pool_dec_(i);settings_audit_(n,"pool.reveal","AccountPool",i.pool_id),t={pool_id:a.pool_id,login:a.login,server:a.server,password:a.password,investor_password:a.investor_password}}var o=sheet_readAll("AccountPool");e.status&&(o=o.filter(function(c){return c.status===e.status})),e.size&&(o=o.filter(function(c){return c.size_usd===Number(e.size)}));var u=o.length,l=Math.min(Math.max(Number(e.limit)||100,1),500),r=Math.max(Number(e.offset)||0,0),s={stock:pool_stock(),total:u,rows:o.slice(r,r+l).map(pool_adminRow_)};return t&&(s.reveal=t),s}
function pool_runTests(){var e=SpreadsheetApp.create("RAVEN-POOL-TEST"),n=[],t=pool_key_,i={user:{user_id:"U-T"},role:"owner"},a="login,password,investor_password,server,size\n";function o(f,s){try{s()}catch(d){n.push(f+": "+d.message)}}function u(f,s){try{f()}catch(d){if(s&&d.message.indexOf(s)<0)throw new Error("wrong message: "+d.message);return}throw new Error("should have failed")}function l(f,s,d,m){return{login:f,password:"Pw"+f+"x",investor_password:"Iv"+f+"y",server:m||"Demo-Srv",size:s}}function r(f){return sheet_readAll("AccountPool").filter(function(s){return s.login===f})[0]}try{sheet_buildAll_(e),settings_clear_(),o("csv parse",function(){var f=pool_parseCsv_("\uFEFF Login , Password,Investor,Server,Size USD\r\n10000001,\"a,b\"\"c\",inv1,Srv A,$1,000\r\n\r\n10000002,p2,inv2,Srv A,5000\r\n"),s=f[0];util_assertEq_(f.length,2,"rows"),util_assertEq_(s.password,'a,b"c',"quoted"),util_assertEq_(s.investor_password,"inv1","alias"),util_assertEq_(f[1].size,"5000","size"),util_assertEq_(f[1]._line,3,"line"),u(function(){pool_parseCsv_("a,b\n1,2")},"header"),util_assertEq_(pool_parseCsv_("").length,0,"empty")}),o("import ok",function(){var f=admin_poolImport({rows:[l("10000001",1e3),l("10000002",1e3),l("10000003",1e3),l("20000001",5e3),l("30000001",1e4)]},i);util_assertEq_(f.imported,5,"imported"),util_assertEq_(f.blocked,!1,"blocked"),util_assert_(/^IB-\d{8}-/.test(f.batch),"batch id");var s=JSON.stringify(f);util_assert_(s.indexOf("Pw1000")<0&&s.indexOf("Iv1000")<0,"no secrets in report"),util_assertEq_(sheet_readAll("AccountPool").filter(function(d){return d.status==="Available"}).length,5,"available"),util_assertEq_(sheet_findRows("AuditLog",{action:"pool.import"}).length,1,"audited")}),o("bad rows block the import",function(){var f=admin_poolImport({rows:[l("40000001",1e3),l("123",1e3),l("40000002",777),{login:"40000003",password:"same",investor_password:"same",server:"S",size:1e3},{login:"40000004",password:"p",server:"S",size:1e3}]},i);util_assertEq_(f.blocked,!0,"blocked"),util_assertEq_(f.imported,0,"none imported"),util_assertEq_(f.rejected.length,4,"4 rejected"),util_assertEq_(f.valid,1,"1 valid"),util_assert_(!r("40000001"),"nothing written"),f=admin_poolImport({rows:[l("40000001",1e3),l("123",1e3)],skip_invalid:!0},i),util_assertEq_(f.imported,1,"valid imported"),util_assert_(r("40000001"),"written")}),o("duplicates",function(){var f=admin_poolImport({rows:[l("10000001",1e3),l("50000001",1e3),l("50000001",1e3)]},i);util_assertEq_(f.duplicates.length,2,"dups"),util_assertEq_(f.duplicates[0].reason,"already in the pool","existing"),util_assertEq_(f.duplicates[1].reason,"repeated in this import","in file"),util_assertEq_(f.blocked,!0,"blocked"),util_assert_(!r("50000001"),"none written")}),o("dry run",function(){var f=admin_poolImport({rows:[l("60000001",1e3)],dry_run:!0},i);util_assertEq_(f.valid,1,"valid"),util_assertEq_(f.imported,0,"none"),util_assert_(!r("60000001"),"nothing written")}),o("server default by size",function(){admin_settingsSet({changes:{pool_server_by_size:'{"1000":"Default-Srv"}'}},i);var f=admin_poolImport({csv:a+"70000001,pw1,inv1,,1000\n"},i);util_assertEq_(f.imported,1,"imported"),util_assertEq_(r("70000001").server,"Default-Srv","server")}),o("assign oldest first, trader-safe",function(){["10000001","10000002","10000003","40000001","70000001"].forEach(function(s,d){sheet_updateRow("AccountPool",r(s),{imported_at:"2026-01-0"+(5-d)+"T00:00:00.000Z"})});var f=pool_assign(1e3,"C-1","U-1");util_assertEq_(f.login,"70000001","oldest first"),util_assertEq_(Object.keys(f).sort().join(","),"login,password,pool_id,server,size_usd","only safe fields");var s=pool_assign(1e3,"C-2","U-2");util_assert_(s.login!==f.login,"different account");var d=r(f.login);util_assertEq_(d.status,"Assigned","status"),util_assertEq_(d.challenge_id,"C-1","linked"),util_assertEq_(d.assigned_to,"U-1","user"),u(function(){pool_assign(1e3,"","U")}),u(function(){pool_assign(0,"C-1","U")})}),o("out of stock",function(){pool_assign(1e4,"C-3","U-3");try{pool_assign(1e4,"C-4","U-4")}catch(f){util_assertEq_(f.outOfStock,!0,"flag"),util_assertEq_(f.code,"BUSY","code");return}throw new Error("should have failed")}),o("mark used",function(){var f=sheet_findRows("AccountPool",{status:"Assigned",size_usd:1e4})[0];util_assertEq_(pool_markUsed(f.pool_id).already,!1,"first"),util_assertEq_(pool_markUsed(f.pool_id).already,!0,"idempotent"),util_assertEq_(sheet_getByKey("AccountPool",f.pool_id).status,"Used","used"),u(function(){pool_markUsed(sheet_findRows("AccountPool",{status:"Available"})[0].pool_id)},"assigned"),u(function(){pool_markUsed("nope")}),u(function(){pool_assign(1e4,"C-5","U-5")})}),o("stock and low-stock",function(){var f=pool_stock(),s=f.filter(function(m){return m.size===1e3})[0];util_assertEq_(s.assigned,2,"assigned 1k"),util_assertEq_(s.available,3,"available 1k"),util_assertEq_(f.filter(function(m){return m.size===1e4})[0].used,1,"used 10k"),util_assertEq_(pool_lowStock().length,3,"all sizes low at default 5"),admin_settingsSet({changes:{pool_low_stock_by_size:'{"1000":2,"5000":0}',pool_low_stock_default:0}},i);var d=pool_lowStock().map(function(m){return m.size});util_assertEq_(d.join(","),"10000","only empty 10k is low"),util_assertEq_(pool_stock().filter(function(m){return m.size===1e3})[0].threshold,2,"override")}),o("admin list masks secrets, reveal is audited",function(){var f=admin_poolList({},i);util_assert_(f.total===7&&f.rows.length===f.total,"rows "+f.total+"/"+f.rows.length),util_assert_(f.rows.every(function(m){return m.password===void 0&&m.investor_password===void 0}),"masked"),util_assertEq_(admin_poolList({status:"Used"},i).rows.length,1,"filter"),util_assertEq_(admin_poolList({size:5e3},i).rows.length,1,"size filter"),u(function(){admin_poolList({status:"Bad"},i)});var s=r("20000001");f=admin_poolList({reveal_id:s.pool_id},i),util_assertEq_(f.reveal.password,"Pw20000001x","password"),util_assertEq_(f.reveal.investor_password,"Iv20000001y","investor"),util_assertEq_(sheet_findRows("AuditLog",{action:"pool.reveal"}).length,1,"reveal audited"),u(function(){admin_poolList({reveal_id:"nope"},i)})}),o("monitor list",function(){var f=pool_monitorList();util_assertEq_(f.length,2,"assigned only"),util_assert_(f.every(function(s){return s.investor_password&&s.login}),"has investor")}),o("encryption at rest",function(){pool_key_=function(){return"k".repeat(32)};var f=admin_poolImport({rows:[{login:"80000001",password:"Sécret,pw",investor_password:"inv-ö",server:"S",size:5e3}]},i);util_assertEq_(f.encrypted,!0,"flag");var s=r("80000001");util_assertEq_(s.encrypted,!0,"stored flag"),util_assert_(s.password.indexOf("enc1.")===0&&s.password.indexOf("Sécret")<0&&s.investor_password.indexOf("inv")<0,"ciphertext");var d=pool_assign(5e3,"C-9","U-9");util_assertEq_(d.login,"20000001","plain oldest first"),d=pool_assign(5e3,"C-10","U-10"),util_assertEq_(d.login,"80000001","enc assign"),util_assertEq_(d.password,"Sécret,pw","decrypted"),util_assertEq_(admin_poolList({reveal_id:s.pool_id},i).reveal.investor_password,"inv-ö","reveal"),util_assertEq_(admin_poolList({},i).rows.length>0,!0,"list works"),admin_poolImport({rows:[{login:"80000002",password:"a1",investor_password:"b2",server:"S",size:5e3}]},i);var m=r("80000002"),h=m.password.split(".");h[3]=h[3].slice(0,-1)+(h[3].slice(-1)==="0"?"1":"0"),sheet_updateRow("AccountPool",m,{password:h.join(".")}),u(function(){pool_assign(5e3,"C-11","U-11")},"decrypted"),util_assertEq_(r("80000002").status,"Available","left available on failure"),pool_key_=function(){return null},u(function(){pool_assign(5e3,"C-11","U-11")},"POOL_ENC_KEY"),util_assertEq_(r("80000002").status,"Available","still available")}),o("size limit",function(){var f=[];for(var s=0;s<501;s++)f.push(l("9"+("0000000"+s).slice(-8),1e3));u(function(){admin_poolImport({rows:f},i)},"at most"),u(function(){admin_poolImport({},i)}),u(function(){admin_poolImport({csv:a},i)},"Nothing")})}finally{pool_key_=t,sheet_setSpreadsheet_(null),settings_clear_();try{DriveApp.getFileById(e.getId()).setTrashed(!0)}catch{}}if(n.length)throw new Error("Failed: "+n.join(" | "));console.log("ALL PART 8 TESTS PASSED")}

// ===== PART 9: RULES ENGINE (minified; top-level names kept) =====
var RULES_STAGES_={"phase 1":"p1",phase1:"p1",phase_1:"p1",p1:"p1","phase 2":"p2",phase2:"p2",phase_2:"p2",p2:"p2",funded:"funded"};
function rules_bad_(e){return util_error_(CODES.BAD_REQUEST,e)}
function rules_kind_(e){var n=RULES_STAGES_[String(e==null?"":e).trim().toLowerCase()];if(!n)throw rules_bad_("Unknown stage.");return n}
function rules_num_(e,n,t){var i=e===null||e===void 0||e===""||typeof e=="boolean"?NaN:Number(e);if(!isFinite(i)||t&&!(i>0))throw rules_bad_(n+" must be a "+(t?"positive ":"")+"number.");return i}
function rules_used_(e,n,t){var i=e*t/100;return i>0?util_round_(Math.max(0,(e-n)/i*100),2):0}
function rules_limits(e,n){if(!e||typeof e!="object")throw rules_bad_("plan is required.");var t=rules_kind_(n),i=t==="funded",a=function(l,r){return i&&e[r]!=null&&e[r]!==""?Number(e[r]):Number(e[l])},o=a("daily_drawdown","daily_drawdown_funded"),u=a("max_drawdown","max_drawdown_funded"),s=t==="p1"?e.phase1_target:t==="p2"?e.phase2_target:null;if(!(o>0&&o<=100)||!(u>0&&u<=100))throw rules_bad_("Plan loss limits are missing or invalid.");if(!i&&!(Number(s)>0))throw rules_bad_("Plan profit target is missing or invalid.");return{kind:t,funded:i,daily_pct:o,max_pct:u,target_pct:i?null:Number(s)}}
function rules_floor_(e,n,t,i){var a=rules_num_(e,"base balance",!0),o=util_roundMoney_(rules_num_(n,"equity")),u=util_roundMoney_(a-util_pctOf_(a,i));return{breached:o<=u,actual_value:o,allowed_value:u,limit_pct:i,base:a,used_pct:rules_used_(a,o,i)}}
function rules_maxLoss(e,n,t,i){var a=rules_limits(e,n),o=rules_floor_(t,i,"max",a.max_pct);return o.rule="max_loss",o}
function rules_dailyLoss(e,n,t,i){var a=rules_limits(e,n),o=rules_floor_(t,i,"daily",a.daily_pct);return o.rule="daily_loss",o}
function rules_target(e,n,t,i,a,o){var u=rules_limits(e,n);if(u.funded)return{applicable:!1,passed:!1};var l=rules_num_(t,"start_balance",!0),r=util_roundMoney_(rules_num_(i,"balance")),c=util_roundMoney_(rules_num_(a,"equity")),f=util_roundMoney_(l+util_pctOf_(l,u.target_pct)),s=o==null?Math.abs(c-r)<.005:Number(o)===0,d=r>=f;return{applicable:!0,target_pct:u.target_pct,target_balance:f,balance:r,progress_pct:util_round_(Math.max(0,(r-l)/(f-l)*100),2),reached:d,flat:s,flat_inferred:o==null,passed:d&&s}}
function rules_inactivity(e,n,t){var i=Number(e&&e.inactivity_days)||0,a=Number(e&&e.inactivity_warning_days)||0;if(!(i>0))return{applicable:!1,state:"ok",days_inactive:null,warning_day:a,breach_day:i};var o=util_daysBetween_(n,t==null?new Date:t);if(o===null)throw rules_bad_("last_activity_at is missing or invalid.");return o=Math.max(0,o),{applicable:!0,state:o>=i?"breach":a>0&&o>=a?"warning":"ok",days_inactive:o,warning_day:a,breach_day:i}}
function rules_reason(e){var n=e.context||{},t=" Recorded at "+String(e.occurred_at).slice(0,16).replace("T"," ")+" UTC.";return e.rule==="max_loss"?"Your equity fell to "+util_formatUsd_(e.actual_value)+", at or below the maximum loss limit of "+util_formatUsd_(e.allowed_value)+" ("+n.limit_pct+"% below the starting balance of "+util_formatUsd_(n.base)+")."+t:e.rule==="daily_loss"?"Your equity fell to "+util_formatUsd_(e.actual_value)+", at or below the daily loss limit of "+util_formatUsd_(e.allowed_value)+" ("+n.limit_pct+"% below the day's starting balance of "+util_formatUsd_(n.base)+")."+t:e.rule==="inactivity"?"There was no trading activity for "+e.actual_value+" days. The limit is "+e.allowed_value+" days."+t:"The account breached the "+e.rule+" rule."+t}
function rules_breach_(e,n,t){var i={rule:e.rule,actual_value:e.actual_value,allowed_value:e.allowed_value,occurred_at:n,evidence:t,context:{limit_pct:e.limit_pct,base:e.base}};return i.reason=rules_reason(i),i}
function rules_evaluate(e){e=e||{};var n=rules_limits(e.plan,e.stage),t=util_parseTime_(e.at==null?new Date:e.at);if(!t)throw rules_bad_("at is not a valid time.");var i=t.toISOString(),a=rules_num_(e.start_balance,"start_balance",!0),o=rules_num_(e.equity,"equity"),u=e.balance==null||e.balance===""?o:rules_num_(e.balance,"balance"),l=e.evidence==null?"":String(e.evidence).slice(0,200),r=e.warn_pct==null?80:Number(e.warn_pct),c=[],f=[],s=[],d=rules_maxLoss(e.plan,e.stage,a,o);d.breached&&c.push(rules_breach_(d,i,l));var m=null;e.day_start_balance==null||e.day_start_balance===""?s.push("Daily loss not checked: no day-start balance."):(m=rules_dailyLoss(e.plan,e.stage,e.day_start_balance,o),m.breached&&c.push(rules_breach_(m,i,l)));var p=null;if(e.last_activity_at==null||e.last_activity_at==="")s.push("Inactivity not checked: no last activity time.");else if(p=rules_inactivity(e.plan,e.last_activity_at,t),p.state==="breach"){var h={rule:"inactivity",actual_value:p.days_inactive,allowed_value:p.breach_day,occurred_at:i,evidence:l,context:{}};h.reason=rules_reason(h),c.push(h)}var v=rules_target(e.plan,e.stage,a,u,o,e.open_positions);return c.length||(d.used_pct>=r&&f.push({type:"drawdown",rule:"max_loss",used_pct:d.used_pct}),m&&m.used_pct>=r&&f.push({type:"drawdown",rule:"daily_loss",used_pct:m.used_pct}),p&&p.state==="warning"&&f.push({type:"inactivity",days_inactive:p.days_inactive,breach_day:p.breach_day}),v.reached&&!v.flat&&f.push({type:"target_waiting",message:"Target reached: close open positions to pass."})),{status:c.length?"breached":v.passed?"passed":"active",breach:c[0]||null,breaches:c,warnings:f,notes:s,limits:n,max_loss:d,daily_loss:m,target:v,inactivity:p,at:i}}
function rules_dayStart(e,n){return util_dayStart_(n==null?new Date:n,e&&e.daily_reset_tz||"UTC",e&&e.daily_reset_time||"00:00").toISOString()}
function rules_needsDayReset(e,n,t){var i=util_parseTime_(n);return!i||i.getTime()<Date.parse(rules_dayStart(e,t))}
function rules_runTests(){var e=[],n=sheet_readAll,t=sheet_seedPlans_(),i=function(f){return t.filter(function(s){return s.plan_id===f})[0]},a=i("swift-10000"),o=i("apex-10000"),u=i("swift-1000");function l(f,s){try{s()}catch(d){e.push(f+": "+d.message)}}function r(f,s){try{f()}catch(d){if(s&&d.code!==s)throw new Error("wrong code "+d.code);return}throw new Error("should have failed")}function c(f,s){var d={plan:a,stage:"Phase 1",start_balance:1e4,equity:1e4,day_start_balance:1e4,at:"2026-09-28T15:30:00.000Z"};return Object.assign(d,f,s||{}),rules_evaluate(d)}try{sheet_readAll=function(){throw new Error("rules must not read sheets")},l("swift 10k max loss boundary",function(){util_assertEq_(rules_maxLoss(a,"Phase 1",1e4,9400.01).breached,!1,"above"),util_assertEq_(rules_maxLoss(a,"Phase 1",1e4,9400).breached,!0,"at"),util_assertEq_(rules_maxLoss(a,"Phase 1",1e4,9399.99).breached,!0,"below"),util_assertEq_(rules_maxLoss(a,"Phase 1",1e4,9400.004).breached,!0,"cent rounding"),util_assertEq_(rules_maxLoss(a,"Phase 1",1e4,9500).allowed_value,9400,"allowed"),util_assertEq_(rules_maxLoss(u,"Phase 2",1e3,940).breached,!0,"1k at limit"),util_assertEq_(rules_maxLoss(u,"Phase 2",1e3,940.01).breached,!1,"1k above")}),l("apex max loss by stage",function(){util_assertEq_(rules_maxLoss(o,"Phase 1",1e4,8500).breached,!0,"p1 at 8500"),util_assertEq_(rules_maxLoss(o,"Phase 1",1e4,8500.01).breached,!1,"p1 above"),util_assertEq_(rules_maxLoss(o,"Funded",1e4,8200).breached,!1,"funded wider"),util_assertEq_(rules_maxLoss(o,"Funded",1e4,8000).breached,!0,"funded at 8000"),util_assertEq_(rules_maxLoss(a,"Funded",1e4,9400).breached,!0,"swift funded same")}),l("daily loss",function(){util_assertEq_(rules_dailyLoss(a,"Phase 1",10500,10080).breached,!0,"at 10080"),util_assertEq_(rules_dailyLoss(a,"Phase 1",10500,10080.01).breached,!1,"above"),util_assertEq_(rules_dailyLoss(a,"Phase 1",10500,10100).breached,!1,"p1 ok"),util_assertEq_(rules_dailyLoss(a,"Funded",10500,10100).breached,!0,"funded 3%"),util_assertEq_(rules_dailyLoss(a,"Funded",10500,10100).allowed_value,10185,"funded floor")}),l("profit target",function(){var f=function(s,d,m,h){return rules_target(a,s,1e4,d,m,h)};util_assertEq_(f("Phase 1",11e3,11e3).passed,!0,"pass"),util_assertEq_(f("Phase 1",11e3,11e3).target_balance,11e3,"target"),util_assertEq_(f("Phase 1",10999.99,10999.99).passed,!1,"just short"),util_assertEq_(f("Phase 1",11e3,10950).passed,!1,"floating loss = open"),util_assertEq_(f("Phase 1",11e3,10950).reached,!0,"reached"),util_assertEq_(f("Phase 1",11e3,10950,0).passed,!0,"explicit flat"),util_assertEq_(f("Phase 1",11e3,11e3,2).passed,!1,"positions open"),util_assertEq_(f("Phase 2",10500,10500).passed,!0,"p2 5%"),util_assertEq_(f("Phase 2",10499,10499).passed,!1,"p2 short"),util_assertEq_(f("Funded",2e4,2e4).applicable,!1,"funded n/a"),util_assertEq_(f("Phase 1",10500,10500).progress_pct,50,"progress")}),l("inactivity",function(){var f=function(s){return rules_inactivity(a,"2026-09-01T00:00:00.000Z",s)};util_assertEq_(f("2026-09-23T00:00:00.000Z").state,"ok","day 22"),util_assertEq_(f("2026-09-24T00:00:00.000Z").state,"warning","day 23"),util_assertEq_(f("2026-09-30T00:00:00.000Z").state,"warning","day 29"),util_assertEq_(f("2026-10-01T00:00:00.000Z").state,"breach","day 30"),util_assertEq_(f("2026-10-01T00:00:00.000Z").days_inactive,30,"days"),util_assertEq_(rules_inactivity({inactivity_days:0},"2026-01-01","2026-09-01").applicable,!1,"disabled"),r(function(){rules_inactivity(a,"junk","2026-09-01")})}),l("evaluate: active, breach, pass",function(){var f=c({});util_assertEq_(f.status,"active","active"),util_assertEq_(f.breach,null,"no breach"),f=c({equity:9400,balance:9400});var s=f.breach;util_assertEq_(f.status,"breached","breached"),util_assertEq_(s.rule,"max_loss","rule"),util_assertEq_(s.actual_value,9400,"actual"),util_assertEq_(s.allowed_value,9400,"allowed"),util_assertEq_(s.occurred_at,"2026-09-28T15:30:00.000Z","time"),util_assert_(s.reason.indexOf("$9,400.00")>0&&s.reason.indexOf("6%")>0&&s.reason.indexOf("$10,000.00")>0&&s.reason.indexOf("2026-09-28 15:30 UTC")>0,"reason text: "+s.reason),f=c({balance:11e3,equity:11e3}),util_assertEq_(f.status,"passed","passed"),f=c({balance:11e3,equity:10950}),util_assertEq_(f.status,"active","waits for flat"),util_assertEq_(f.warnings.filter(function(d){return d.type==="target_waiting"}).length,1,"waiting warning"),f=c({balance:11e3,equity:9300}),util_assertEq_(f.status,"breached","breach beats pass"),util_assertEq_(c({stage:"Funded",balance:12e3,equity:12e3,day_start_balance:12e3}).status,"active","funded never passes")}),l("evaluate: daily and both rules",function(){var f=c({day_start_balance:10500,equity:10080,balance:10080});util_assertEq_(f.status,"breached","breached"),util_assertEq_(f.breach.rule,"daily_loss","daily"),util_assert_(f.breach.reason.indexOf("day's starting balance of $10,500.00")>0,"daily text"),f=c({day_start_balance:1e4,equity:9300}),util_assertEq_(f.breaches.length,2,"both"),util_assertEq_(f.breach.rule,"max_loss","max first"),util_assertEq_(c({stage:"Funded",day_start_balance:10500,equity:10100}).breach.rule,"daily_loss","funded daily")}),l("evaluate: warnings and notes",function(){var f=c({equity:9520,day_start_balance:9520});util_assertEq_(f.status,"active","still active"),util_assertEq_(f.warnings.length,1,"one warning"),util_assertEq_(f.warnings[0].used_pct,80,"80% used"),util_assertEq_(c({equity:9530,day_start_balance:9530}).warnings.length,0,"78% no warning"),util_assertEq_(c({equity:9530,day_start_balance:9530,warn_pct:70}).warnings.length,1,"custom threshold"),f=c({day_start_balance:null}),util_assertEq_(f.daily_loss,null,"no daily"),util_assertEq_(f.notes.length,2,"notes"),util_assertEq_(c({last_activity_at:"2026-08-29T00:00:00.000Z"}).breach.rule,"inactivity","inactive breach"),util_assertEq_(c({last_activity_at:"2026-08-29T00:00:00.000Z"}).breach.allowed_value,30,"allowed days"),f=c({last_activity_at:"2026-09-05T00:00:00.000Z",at:"2026-09-28T15:30:00.000Z"}),util_assertEq_(f.warnings[0].type,"inactivity","inactivity warning")}),l("day start",function(){util_assertEq_(rules_dayStart({daily_reset_tz:"UTC",daily_reset_time:"00:00"},"2026-09-28T15:30:00.000Z"),"2026-09-28T00:00:00.000Z","midnight"),util_assertEq_(rules_dayStart({daily_reset_tz:"UTC",daily_reset_time:"22:00"},"2026-09-28T15:30:00.000Z"),"2026-09-27T22:00:00.000Z","22:00 reset"),util_assertEq_(rules_needsDayReset(a,"2026-09-27T00:00:00.000Z","2026-09-28T15:30:00.000Z"),!0,"stale"),util_assertEq_(rules_needsDayReset(a,"2026-09-28T00:00:00.000Z","2026-09-28T15:30:00.000Z"),!1,"current"),util_assertEq_(rules_needsDayReset(a,"","2026-09-28T15:30:00.000Z"),!0,"blank")}),l("stage names and bad input",function(){["phase 1","Phase 1","PHASE1","p1","phase_1"].forEach(function(f){util_assertEq_(rules_limits(a,f).kind,"p1",f)}),util_assertEq_(rules_limits(a,"Funded").max_pct,6,"funded"),util_assertEq_(rules_limits(o,"Funded").max_pct,20,"apex funded"),r(function(){rules_limits(a,"Phase 3")},"BAD_REQUEST"),r(function(){rules_limits(null,"Phase 1")},"BAD_REQUEST"),r(function(){c({equity:"abc"})},"BAD_REQUEST"),r(function(){c({start_balance:0})},"BAD_REQUEST"),r(function(){c({start_balance:null})},"BAD_REQUEST"),r(function(){c({at:"nonsense"})},"BAD_REQUEST"),r(function(){c({plan:Object.assign({},a,{max_drawdown:0})})},"BAD_REQUEST")}),l("plan with no funded overrides falls back",function(){var f=Object.assign({},a,{max_drawdown_funded:null,daily_drawdown_funded:""});util_assertEq_(rules_limits(f,"Funded").max_pct,6,"max"),util_assertEq_(rules_limits(f,"Funded").daily_pct,4,"daily")})}finally{sheet_readAll=n}if(e.length)throw new Error("Failed: "+e.join(" | "));console.log("ALL PART 9 TESTS PASSED")}

// ===== PART 10: CHALLENGE AND STAGE LIFECYCLE =====
// Hierarchy: USER > CHALLENGE > Phase 1 account > Phase 2 account > Funded account > payouts.
// A challenge's state is stage + status. Only these moves work; everything else is refused:
//   Phase 1|Active -> Phase 1|Passed | Phase 1|Breached
//   Phase 1|Passed -> Phase 2|Active   (a NEW pool account is assigned)
//   Phase 2|Active -> Phase 2|Passed | Phase 2|Breached
//   Phase 2|Passed -> Funded|Active    (a NEW pool account is assigned)
//   Funded|Active  -> Funded|Breached
// createChallenge is called only by the payment core (Part 11). Every transition is written to
// Challenges.status_history with who or what caused it (ctx.by, or the logged-in role and user).
// If the pool is empty when a stage is passed, the challenge waits in "Passed" (old account closed)
// until chal_activateNext succeeds after the pool is restocked.
var CHAL_TRANSITIONS_={
  'Phase 1|Active':['Phase 1|Passed','Phase 1|Breached'],
  'Phase 1|Passed':['Phase 2|Active'],
  'Phase 2|Active':['Phase 2|Passed','Phase 2|Breached'],
  'Phase 2|Passed':['Funded|Active'],
  'Funded|Active':['Funded|Breached'],
  'Phase 1|Breached':[],'Phase 2|Breached':[],'Funded|Breached':[]
};
var CHAL_NEXT_STAGE_={'Phase 1':'Phase 2','Phase 2':'Funded'};
function chal_bad_(m){return util_error_(CODES.BAD_REQUEST,m);}
function chal_by_(ctx){
  if(ctx&&ctx.by)return String(ctx.by).slice(0,60);
  if(ctx&&ctx.user)return (ctx.role||'user')+':'+ctx.user.user_id;
  return 'system';
}
function chal_history_(ch){var h=sheet_jsonParse_(ch.status_history,[]);return Array.isArray(h)?h:[];}
function chal_push_(hist,from,to,at,by,note){
  hist=hist.slice();
  hist.push({from:from,to:to,at:at,by:by,note:note?String(note).slice(0,200):''});
  return hist.length>200?hist.slice(-200):hist;
}
function chal_state_(ch){return ch.stage+'|'+ch.status;}
function chal_assertMove_(ch,toState){
  if((CHAL_TRANSITIONS_[chal_state_(ch)]||[]).indexOf(toState)===-1)
    throw chal_bad_('This challenge cannot move from '+chal_state_(ch).replace('|',' ')+' to '+toState.replace('|',' ')+'.');
}
function chal_get_(id){
  var ch=typeof id==='string'&&id?sheet_getByKey('Challenges',id):null;
  if(!ch)throw chal_bad_('Challenge not found.');
  return ch;
}
function chal_currentAccount_(ch){
  var a=ch.current_account_id?sheet_getByKey('Accounts',ch.current_account_id):null;
  return a||sheet_findOne('Accounts',{challenge_id:ch.challenge_id,status:'Active'});
}
function chal_accountRow_(accountId,ch,plan,cred,stage,now){
  var size=ch.account_size_usd;
  return {account_id:accountId,challenge_id:ch.challenge_id,user_id:ch.user_id,stage:stage,pool_id:cred.pool_id,
    login:cred.login,size_usd:size,start_balance:size,status:'Active',day_start_balance:size,
    day_start_date:rules_dayStart(plan,now),last_balance:size,last_equity:size,assigned_at:now};
}
function chal_releasePool_(poolId){
  try{
    var p=sheet_getByKey('AccountPool',poolId);
    if(p&&p.status==='Assigned')sheet_updateRow('AccountPool',p,{status:'Available',assigned_to:'',challenge_id:'',assigned_at:''});
  }catch(e){console.error('chal_releasePool_: '+e);}
}
function chal_bundle_(ch,created){return {created:created,challenge:ch,account:chal_currentAccount_(ch)};}

// Creates the challenge and assigns the Phase 1 account. Exactly once per order_ref, and only
// from a confirmed payment. Out of stock -> BUSY error and nothing is written.
function chal_createChallenge(spec,ctx){
  spec=spec||{};
  var userId=String(spec.user_id||''),planId=String(spec.plan_id||''),ref=String(spec.order_ref||'');
  if(!userId||!planId||!ref)throw chal_bad_('user_id, plan_id and order_ref are required.');
  return util_withLock_(function(){
    var existing=sheet_findOne('Challenges',{order_ref:ref});
    if(existing)return chal_bundle_(existing,false);
    var pay=sheet_getByKey('Payments',ref);
    if(!pay||pay.status!=='confirmed'||pay.user_id!==userId||pay.plan_id!==planId)
      throw chal_bad_('A challenge can only be created from a confirmed payment.');
    if(!sheet_getByKey('Users',userId))throw chal_bad_('Unknown user.');
    var plan=settings_getPlan(planId);
    if(!plan)throw chal_bad_('Unknown plan.');
    var now=util_nowIso_(),by=chal_by_(ctx);
    var chId=sheet_newKey_('Challenges'),acId=sheet_newKey_('Accounts');
    var cred=pool_assign(plan.account_size_usd,chId,userId); // throws BUSY (outOfStock) before anything is written
    var ch=null,acct=null;
    try{
      ch=sheet_appendRow('Challenges',{challenge_id:chId,user_id:userId,plan_id:planId,style:plan.style,
        account_size_usd:plan.account_size_usd,stage:'Phase 1',status:'Active',current_account_id:acId,
        order_ref:ref,payouts_paid:0,created_at:now,updated_at:now,
        status_history:chal_push_([],'','Phase 1|Active',now,by,'challenge created')});
      try{
        acct=sheet_appendRow('Accounts',chal_accountRow_(acId,ch,plan,cred,'Phase 1',now));
      }catch(e){sheet_deleteWhere('Challenges',{challenge_id:chId});throw e;}
    }catch(e){chal_releasePool_(cred.pool_id);throw e;}
    return {created:true,challenge:ch,account:acct};
  });
}

// Assigns the next-stage account to a challenge sitting in "Passed". Used by passStage and, after a
// restock, by chal_activateNext.
function chal_openNext_(ch,ctx){
  if(ch.status!=='Passed'||!CHAL_NEXT_STAGE_[ch.stage])throw chal_bad_('This challenge is not waiting for its next account.');
  var next=CHAL_NEXT_STAGE_[ch.stage];
  chal_assertMove_(ch,next+'|Active');
  var now=util_nowIso_(),by=chal_by_(ctx),cred=null;
  try{cred=pool_assign(ch.account_size_usd,ch.challenge_id,ch.user_id);}
  catch(e){if(e&&e.outOfStock)return {challenge:ch,waiting_for_account:true,stage:next};throw e;}
  var acId=sheet_newKey_('Accounts'),acct=null;
  try{acct=sheet_appendRow('Accounts',chal_accountRow_(acId,ch,settings_getPlan(ch.plan_id),cred,next,now));}
  catch(e){chal_releasePool_(cred.pool_id);throw e;}
  var changes={stage:next,status:'Active',current_account_id:acId,updated_at:now,
    status_history:chal_push_(chal_history_(ch),chal_state_(ch),next+'|Active',now,by,'new account assigned')};
  if(next==='Funded')changes.funded_at=now;
  try{ch=sheet_updateRow('Challenges',ch,changes);}
  catch(e){sheet_deleteWhere('Accounts',{account_id:acId});chal_releasePool_(cred.pool_id);throw e;}
  return {challenge:ch,account:acct,waiting_for_account:false,stage:next};
}

// Target reached: closes the old account (pool -> Used) and assigns a NEW account for the next stage.
function chal_passStage(challengeId,ctx){
  return util_withLock_(function(){
    var ch=chal_get_(challengeId);
    if(ch.status!=='Active'||!CHAL_NEXT_STAGE_[ch.stage])throw chal_bad_('Only an active Phase 1 or Phase 2 challenge can be passed.');
    chal_assertMove_(ch,ch.stage+'|Passed');
    var now=util_nowIso_(),by=chal_by_(ctx),acct=chal_currentAccount_(ch);
    if(acct){
      sheet_updateRow('Accounts',acct,{status:'Passed',closed_at:now,close_reason:'target_reached'});
      pool_markUsed(acct.pool_id);
    }
    ch=sheet_updateRow('Challenges',ch,{status:'Passed',current_account_id:'',updated_at:now,
      status_history:chal_push_(chal_history_(ch),chal_state_(ch),ch.stage+'|Passed',now,by,ctx&&ctx.note)});
    return chal_openNext_(ch,ctx);
  });
}
function chal_activateNext(challengeId,ctx){
  return util_withLock_(function(){return chal_openNext_(chal_get_(challengeId),ctx);});
}

function chal_optNum_(v,name){
  if(v===undefined||v===null||v==='')return '';
  var n=typeof v==='boolean'?NaN:Number(v);
  if(!isFinite(n))throw chal_bad_(name+' must be a number.');
  return n;
}
// Breach from any Active stage: BreachLog row (rule, actual, allowed, time, evidence, admin note),
// account closed, pool account -> Used. Repeating it is harmless: no second BreachLog row.
function chal_breachStage(challengeId,breach,ctx){
  breach=breach||{};
  var rule=String(breach.rule||'').trim().toLowerCase();
  if(!/^[a-z_]{2,40}$/.test(rule))throw chal_bad_('A breach needs a rule name.');
  var actual=chal_optNum_(breach.actual_value,'actual_value'),allowed=chal_optNum_(breach.allowed_value,'allowed_value');
  var at=breach.occurred_at==null||breach.occurred_at===''?new Date():util_parseTime_(breach.occurred_at);
  if(!at)throw chal_bad_('occurred_at is not a valid time.');
  return util_withLock_(function(){
    var ch=chal_get_(challengeId);
    if(ch.status==='Breached'){
      var prev=sheet_findRows('BreachLog',{challenge_id:ch.challenge_id});
      return {challenge:ch,already:true,breach:prev[prev.length-1]||null};
    }
    if(ch.status!=='Active')throw chal_bad_('Only an active challenge can be breached.');
    chal_assertMove_(ch,ch.stage+'|Breached');
    var acct=chal_currentAccount_(ch);
    if(!acct)throw util_error_(CODES.INTERNAL,'This challenge has no active account.');
    var now=util_nowIso_(),by=chal_by_(ctx);
    var log=sheet_findOne('BreachLog',{challenge_id:ch.challenge_id,account_id:acct.account_id});
    if(!log)log=sheet_appendRow('BreachLog',{breach_id:sheet_newKey_('BreachLog'),challenge_id:ch.challenge_id,
      account_id:acct.account_id,user_id:ch.user_id,login:acct.login,rule:rule,actual_value:actual,allowed_value:allowed,
      occurred_at:at.toISOString(),evidence:String(breach.evidence||'').slice(0,500),
      admin_note:String(breach.admin_note||'').slice(0,500),recorded_by:by,created_at:now});
    sheet_updateRow('Accounts',acct,{status:'Breached',closed_at:now,close_reason:rule});
    pool_markUsed(acct.pool_id);
    ch=sheet_updateRow('Challenges',ch,{status:'Breached',breached_at:now,updated_at:now,
      status_history:chal_push_(chal_history_(ch),chal_state_(ch),ch.stage+'|Breached',now,by,rule)});
    return {challenge:ch,already:false,breach:log};
  });
}

// ---- Trader actions (own challenges only; investor password is never returned) ----
function chal_pub_(ch){
  return {challenge_id:ch.challenge_id,plan_id:ch.plan_id,style:ch.style,account_size_usd:ch.account_size_usd,
    stage:ch.stage,status:ch.status,payouts_paid:ch.payouts_paid||0,created_at:ch.created_at,
    funded_at:ch.funded_at,breached_at:ch.breached_at};
}
function chal_listMine(p,ctx){
  var uid=ctx.user.user_id;
  return {challenges:sheet_findRows('Challenges',{user_id:uid}).map(chal_pub_)};
}
function chal_dashboard(p,ctx){
  p=p||{};
  var ch=chal_get_(p.challenge_id);
  if(ch.user_id!==ctx.user.user_id)throw chal_bad_('Challenge not found.'); // same message: no ownership leak
  var accounts=sheet_findRows('Accounts',{challenge_id:ch.challenge_id}).map(function(a){
    return {account_id:a.account_id,stage:a.stage,status:a.status,login:a.login,size_usd:a.size_usd,
      start_balance:a.start_balance,last_balance:a.last_balance,last_equity:a.last_equity,
      last_update_at:a.last_update_at,updated_ago:a.last_update_at?util_timeAgo_(a.last_update_at):'',
      assigned_at:a.assigned_at,closed_at:a.closed_at,close_reason:a.close_reason};
  });
  var out={challenge:chal_pub_(ch),accounts:accounts,credentials:null,breach:null,rules:null,
    waiting_for_account:ch.status==='Passed'};
  var cur=ch.status==='Active'?chal_currentAccount_(ch):null;
  if(cur){
    var pool=sheet_getByKey('AccountPool',cur.pool_id);
    if(pool){var d=pool_dec_(pool);out.credentials={login:d.login,password:d.password,server:d.server};}
  }
  if(ch.status==='Breached'){
    var logs=sheet_findRows('BreachLog',{challenge_id:ch.challenge_id}),b=logs[logs.length-1];
    if(b)out.breach={rule:b.rule,actual_value:b.actual_value,allowed_value:b.allowed_value,occurred_at:b.occurred_at};
  }
  try{var plan=settings_getPlan(ch.plan_id);if(plan)out.rules=rules_limits(plan,ch.stage==='Passed'?'Phase 1':ch.stage);}catch(e){}
  return out;
}

// ---- Test: editor only, throwaway spreadsheet ----
function chal_runTests(){
  var ss=SpreadsheetApp.create('RAVEN-CHAL-TEST'),bad=[],owner={user:{user_id:'U-OWN'},role:'owner'},sys={by:'system:test'};
  function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  function fails(f,code){try{f();}catch(e){if(code&&e.code!==code)throw new Error('wrong code '+e.code+': '+e.message);return;}throw new Error('should have failed');}
  function user(id){sheet_appendRow('Users',{user_id:id,email:id.toLowerCase()+'@t.com',password_hash:'x',role:'trader',status:'active',created_at:util_nowIso_()});}
  function order(ref,uid,plan,status){sheet_appendRow('Payments',{order_ref:ref,user_id:uid,plan_id:plan,gateway:'manual',country:'JP',status:status||'confirmed',created_at:util_nowIso_()});}
  function stock(logins,size){
    var r=admin_poolImport({rows:logins.map(function(l){return {login:l,password:'Pw'+l+'x',investor_password:'Iv'+l+'y',server:'Demo-Srv',size:size};})},owner);
    util_assertEq_(r.imported,logins.length,'imported');
  }
  function pool(login){return sheet_readAll('AccountPool').filter(function(x){return x.login===login;})[0];}
  function chOf(id){return sheet_getByKey('Challenges',id);}
  try{
    sheet_buildAll_(ss);settings_clear_();
    user('U-A');user('U-B');
    stock(['10000001','10000002','10000003','10000004','10000005'],10000); // walk uses 3, the breach test 1, leaving 1
    var walk=null;
    t('create needs a confirmed payment',function(){
      order('RV-T-PEND','U-A','swift-10000','awaiting_payment');
      fails(function(){chal_createChallenge({user_id:'U-A',plan_id:'swift-10000',order_ref:'RV-T-PEND'},sys);});
      fails(function(){chal_createChallenge({user_id:'U-A',plan_id:'swift-10000',order_ref:'RV-T-NONE'},sys);});
      order('RV-T-1','U-A','swift-10000');
      fails(function(){chal_createChallenge({user_id:'U-B',plan_id:'swift-10000',order_ref:'RV-T-1'},sys);});
      fails(function(){chal_createChallenge({user_id:'U-A',plan_id:'apex-10000',order_ref:'RV-T-1'},sys);});
      util_assertEq_(sheet_readAll('Challenges').length,0,'nothing created by refusals');
    });
    t('create phase 1',function(){
      var r=chal_createChallenge({user_id:'U-A',plan_id:'swift-10000',order_ref:'RV-T-1'},sys);
      walk=r.challenge.challenge_id;
      util_assertEq_(r.created,true,'created');
      util_assertEq_(r.challenge.stage+'|'+r.challenge.status,'Phase 1|Active','state');
      util_assertEq_(r.challenge.account_size_usd,10000,'size');
      util_assertEq_(r.account.stage,'Phase 1','acct stage');util_assertEq_(r.account.start_balance,10000,'start');
      util_assertEq_(r.challenge.current_account_id,r.account.account_id,'linked');
      util_assertEq_(pool(r.account.login).status,'Assigned','pool assigned');
      util_assertEq_(pool(r.account.login).challenge_id,walk,'pool linked');
      var h=chal_history_(r.challenge);util_assertEq_(h.length,1,'history');util_assertEq_(h[0].by,'system:test','by');
    });
    t('replay creates no second challenge',function(){
      var r=chal_createChallenge({user_id:'U-A',plan_id:'swift-10000',order_ref:'RV-T-1'},sys);
      util_assertEq_(r.created,false,'not created again');util_assertEq_(r.challenge.challenge_id,walk,'same challenge');
      util_assertEq_(sheet_readAll('Challenges').length,1,'one challenge');
      util_assertEq_(sheet_readAll('AccountPool').filter(function(x){return x.status==='Assigned';}).length,1,'one assigned');
    });
    t('walk phase 1 -> phase 2 -> funded',function(){
      var a1=chal_currentAccount_(chOf(walk));
      var r=chal_passStage(walk,sys);
      util_assertEq_(r.challenge.stage+'|'+r.challenge.status,'Phase 2|Active','phase 2');
      util_assert_(r.account.login!==a1.login&&r.account.pool_id!==a1.pool_id,'NEW account for phase 2');
      util_assertEq_(sheet_getByKey('Accounts',a1.account_id).status,'Passed','old account closed');
      util_assertEq_(pool(a1.login).status,'Used','old pool Used');
      util_assertEq_(pool(r.account.login).status,'Assigned','new pool Assigned');
      var a2=r.account;
      r=chal_passStage(walk,sys);
      util_assertEq_(r.challenge.stage+'|'+r.challenge.status,'Funded|Active','funded');
      util_assert_(!!r.challenge.funded_at,'funded_at');
      util_assertEq_(pool(a2.login).status,'Used','phase 2 pool Used');
      util_assertEq_(sheet_findRows('Accounts',{challenge_id:walk}).length,3,'3 accounts');
      util_assertEq_(chal_history_(chOf(walk)).length,5,'history: create + 2 x (pass, next)');
      fails(function(){chal_passStage(walk,sys);});
      chal_breachStage(walk,{rule:'max_loss',actual_value:8000,allowed_value:8000},sys); // funded can breach
      util_assertEq_(chOf(walk).stage+'|'+chOf(walk).status,'Funded|Breached','funded breached');
    });
    var br=null;
    t('breach phase 1',function(){
      order('RV-T-2','U-B','swift-10000');
      var r=chal_createChallenge({user_id:'U-B',plan_id:'swift-10000',order_ref:'RV-T-2'},sys);br=r.challenge.challenge_id;
      var b=chal_breachStage(br,{rule:'Max_Loss',actual_value:9400,allowed_value:9400,occurred_at:'2026-09-28T15:30:00Z',evidence:'equity upload #7',admin_note:'checked'},owner);
      util_assertEq_(b.already,false,'first breach');
      util_assertEq_(b.breach.rule,'max_loss','rule');util_assertEq_(b.breach.actual_value,9400,'actual');
      util_assertEq_(b.breach.allowed_value,9400,'allowed');util_assertEq_(b.breach.occurred_at,'2026-09-28T15:30:00.000Z','time');
      util_assertEq_(b.breach.evidence,'equity upload #7','evidence');util_assertEq_(b.breach.recorded_by,'owner:U-OWN','recorded by');
      util_assertEq_(chOf(br).status,'Breached','challenge breached');util_assert_(!!chOf(br).breached_at,'breached_at');
      util_assertEq_(pool(r.account.login).status,'Used','pool Used');
      util_assertEq_(sheet_getByKey('Accounts',r.account.account_id).status,'Breached','acct breached');
      util_assertEq_(sheet_getByKey('Accounts',r.account.account_id).close_reason,'max_loss','close reason');
    });
    t('breach is repeatable-safe and final',function(){
      var again=chal_breachStage(br,{rule:'max_loss'},sys);
      util_assertEq_(again.already,true,'already');
      util_assertEq_(sheet_findRows('BreachLog',{challenge_id:br}).length,1,'one log row');
      fails(function(){chal_passStage(br,sys);});
      fails(function(){chal_activateNext(br,sys);});
      fails(function(){chal_breachStage(br,{rule:''},sys);});
      fails(function(){chal_breachStage(br,{rule:'max_loss',actual_value:'abc'},sys);});
    });
    t('interrupted breach resumes without a second BreachLog row',function(){
      order('RV-T-CRASH','U-B','swift-10000');
      stock(['10000007'],10000);
      var r=chal_createChallenge({user_id:'U-B',plan_id:'swift-10000',order_ref:'RV-T-CRASH'},sys),id=r.challenge.challenge_id;
      // simulate a crash right after the BreachLog write: the log row exists, the challenge is still Active
      sheet_appendRow('BreachLog',{breach_id:sheet_newKey_('BreachLog'),challenge_id:id,account_id:r.account.account_id,user_id:'U-B',
        login:r.account.login,rule:'daily_loss',occurred_at:util_nowIso_(),created_at:util_nowIso_()});
      var b=chal_breachStage(id,{rule:'daily_loss',actual_value:1,allowed_value:2},sys);
      util_assertEq_(b.already,false,'completed now');
      util_assertEq_(sheet_findRows('BreachLog',{challenge_id:id}).length,1,'still one log row');
      util_assertEq_(chOf(id).status,'Breached','breached');util_assertEq_(pool(r.account.login).status,'Used','pool Used');
    });
    t('out of stock: create is clean, pass waits, restock resumes',function(){
      order('RV-T-3','U-A','swift-10000');
      var stockBefore=sheet_readAll('AccountPool').filter(function(x){return x.status==='Available';}).length;
      util_assertEq_(stockBefore,1,'one left');
      var c=chal_createChallenge({user_id:'U-A',plan_id:'swift-10000',order_ref:'RV-T-3'},sys).challenge.challenge_id;
      order('RV-T-4','U-A','swift-10000');
      fails(function(){chal_createChallenge({user_id:'U-A',plan_id:'swift-10000',order_ref:'RV-T-4'},sys);},CODES.BUSY);
      util_assertEq_(sheet_readAll('Challenges').filter(function(x){return x.order_ref==='RV-T-4';}).length,0,'no challenge on empty pool');
      var r=chal_passStage(c,sys);
      util_assertEq_(r.waiting_for_account,true,'waiting');
      util_assertEq_(chOf(c).stage+'|'+chOf(c).status,'Phase 1|Passed','parked as Passed');
      fails(function(){chal_breachStage(c,{rule:'max_loss'},sys);});
      stock(['10000006'],10000);
      r=chal_activateNext(c,sys);
      util_assertEq_(r.challenge.stage+'|'+r.challenge.status,'Phase 2|Active','resumed');
      fails(function(){chal_activateNext(c,sys);});
    });
    t('trader views are safe and private',function(){
      var mine=chal_listMine({},{user:{user_id:'U-A'},role:'trader'});
      util_assertEq_(mine.challenges.length,2,'own challenges only');
      var d=chal_dashboard({challenge_id:walk},{user:{user_id:'U-A'},role:'trader'});
      var s=JSON.stringify(d);
      util_assert_(s.indexOf('Iv1000')<0&&s.toLowerCase().indexOf('investor')<0,'no investor password');
      util_assertEq_(d.credentials,null,'no credentials for a breached challenge');
      util_assertEq_(d.breach.rule,'max_loss','breach shown');
      var live=chal_dashboard({challenge_id:mine.challenges.filter(function(x){return x.status==='Active';})[0].challenge_id},{user:{user_id:'U-A'},role:'trader'});
      util_assertEq_(Object.keys(live.credentials).sort().join(','),'login,password,server','credentials: login, password, server only');
      fails(function(){chal_dashboard({challenge_id:br},{user:{user_id:'U-A'},role:'trader'});});
      fails(function(){chal_dashboard({challenge_id:'nope'},{user:{user_id:'U-A'},role:'trader'});});
    });
  }finally{
    sheet_setSpreadsheet_(null);settings_clear_();
    try{DriveApp.getFileById(ss.getId()).setTrashed(true);}catch(e){}
  }
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 10 TESTS PASSED');
}
