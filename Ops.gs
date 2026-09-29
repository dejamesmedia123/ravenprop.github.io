// =====================================================================
// RAVEN PROP BACKEND: Ops.gs
// Admin API actions, equity endpoint, notifications, triggers. Parts 16-18.
// Prefixes: admin_, equity_, notify_.
// =====================================================================

// ===== PART 16: ADMIN API ACTIONS =====
// Money-domain admin actions live next to their domain (Money.gs: payouts, KYC, crypto orders, affiliates; Engine.gs:
// plans, FX, promos, pool; Access.gs: settings). This section adds the rest: overview, users, roles, countries,
// challenges and review, payments, breaches and the audit log.
// Rules for every function here: the router has already checked the role, and each function checks it again
// (pay_requireAdmin_). The router removes user_id and role from every payload, so these actions use target_user_id
// and new_role. Password hashes, reset tokens and pool passwords are never returned. Investor passwords stay
// on the pool screens (admin_poolList). Every change writes an AuditLog row.
function admin_bad_(m){return util_error_(CODES.BAD_REQUEST,m);}
function admin_need_(ctx){pay_requireAdmin_(ctx);}
function admin_limit_(v,def,max){var n=Math.floor(Number(v));return isFinite(n)&&n>=1?Math.min(n,max):def;}
function admin_desc_(rows,field){return rows.slice().sort(function(a,b){return String(b[field]||'').localeCompare(String(a[field]||''));});}
function admin_has_(q,list){
  var s=String(q||'').trim().toLowerCase();if(!s)return true;
  return list.some(function(x){return String(x==null?'':x).toLowerCase().indexOf(s)>=0;});
}
function admin_userMap_(){var m={};sheet_readAll('Users').forEach(function(u){m[u.user_id]=u;});return m;}
function admin_brief_(u){return {email:u?u.email:'',full_name:u?u.full_name:''};}
function admin_safeUser_(u){
  var o={};Object.keys(u).forEach(function(k){if(k!=='password_hash'&&k!=='reset_token_hash'&&k!=='reset_expires_at'&&k!=='_row')o[k]=u[k];});
  return o;
}
function admin_count_(rows,pick){var c={};rows.forEach(function(r){var k=pick(r);c[k]=(c[k]||0)+1;});return c;}
function admin_usd_(rows,pick){var c=0;rows.forEach(function(r){if(pick(r))c+=util_toCents_(r.amount_usd||0);});return util_fromCents_(c);}

// ---- Overview ----
function admin_overview(p,ctx){
  admin_need_(ctx);
  var now=Date.now(),day=864e5,startOfDay=new Date(now);startOfDay.setUTCHours(0,0,0,0);
  var pays=sheet_readAll('Payments'),users=sheet_readAll('Users'),chs=sheet_readAll('Challenges'),pos=sheet_readAll('Payouts');
  var paid=pays.filter(function(o){return o.status==='confirmed'||o.status==='challenge_created';});
  function since(ms){return admin_usd_(paid,function(o){return Date.parse(o.confirmed_at||o.created_at)>=ms;});}
  var openPayout=function(r){return r.status==='Submitted'||r.status==='Under Review'||r.status==='Approved';};
  var affs=sheet_readAll('Affiliates'),affTx=sheet_readAll('AffiliateTransactions');
  var openWd=affTx.filter(function(r){return r.type==='withdrawal'&&(r.status==='requested'||r.status==='approved');});
  var pending={
    crypto_orders:pays.filter(function(o){return o.gateway==='manual'&&o.status==='awaiting_confirmation';}).length,
    payouts:pos.filter(openPayout).length,
    kyc:sheet_readAll('KYC').filter(function(k){return k.status==='Under Review';}).length,
    affiliate_applications:affs.filter(function(a){return a.status==='pending';}).length,
    affiliate_withdrawals:openWd.length,
    paid_waiting_for_account:pays.filter(function(o){return o.status==='confirmed';}).length,
    challenges_waiting_for_account:chs.filter(function(c){return c.status==='Passed';}).length,
    support_tickets:sheet_readAll('SupportTickets').filter(function(t){return t.status==='open';}).length
  };
  var low=pool_lowStock(),flagged=affs.filter(function(a){return a.flagged;}).length;
  var breaches7=sheet_readAll('BreachLog').filter(function(b){return Date.parse(b.occurred_at)>=now-7*day;}).length;
  var attention=[
    ['crypto_orders','Crypto orders awaiting confirmation','crypto',pending.crypto_orders],
    ['payouts','Payouts to review','payouts',pending.payouts],
    ['kyc','KYC to review','payouts',pending.kyc],
    ['paid_waiting_for_account','Paid orders waiting for an account','payments',pending.paid_waiting_for_account],
    ['challenges_waiting_for_account','Passed challenges waiting for an account','challenges',pending.challenges_waiting_for_account],
    ['affiliate_withdrawals','Affiliate withdrawals to review','affiliates',pending.affiliate_withdrawals],
    ['affiliate_applications','Affiliate applications','affiliates',pending.affiliate_applications],
    ['flagged_affiliates','Flagged affiliates','affiliates',flagged],
    ['low_stock','Account sizes low on stock','pool',low.length],
    ['support_tickets','Open support tickets','users',pending.support_tickets]
  ].filter(function(x){return x[3]>0;}).map(function(x){return {key:x[0],label:x[1],screen:x[2],count:x[3]};});
  return {
    revenue:{today_usd:since(startOfDay.getTime()),last_7d_usd:since(now-7*day),last_30d_usd:since(now-30*day),
      all_time_usd:admin_usd_(paid,function(){return true;}),refunded_usd:admin_usd_(pays,function(o){return o.status==='refunded';})},
    orders:admin_count_(pays,function(o){return o.status;}),
    challenges:{active:chs.filter(function(c){return c.status==='Active';}).length,by_state:admin_count_(chs,function(c){return c.stage+'|'+c.status;})},
    payouts:{open:pos.filter(openPayout).length,open_usd:admin_usd_(pos,openPayout),paid_usd:admin_usd_(pos,function(r){return r.status==='Paid';}),
      paid_count:pos.filter(function(r){return r.status==='Paid';}).length},
    affiliates:{active:affs.filter(function(a){return a.status==='active';}).length,open_withdrawals_usd:admin_usd_(openWd,function(){return true;})},
    breaches_last_7d:breaches7,
    pool:{stock:pool_stock(),low:low},
    users:{total:users.length,new_last_7d:users.filter(function(u){return Date.parse(u.created_at)>=now-7*day;}).length,
      restricted:users.filter(function(u){return u.status==='restricted';}).length,banned:users.filter(function(u){return u.status==='banned';}).length},
    pending:pending,attention:attention
  };
}

// ---- Users ----
// No target_user_id = search (q matches email, name, phone or id; status filter). With one = full detail.
function admin_usersList(p,ctx){
  admin_need_(ctx);p=p||{};
  if(p.target_user_id){
    var u=sheet_getByKey('Users',String(p.target_user_id));if(!u)throw admin_bad_('User not found.');
    var k=sheet_findOne('KYC',{user_id:u.user_id}),a=aff_byUser_(u.user_id);
    return {user:admin_safeUser_(u),kyc:k,affiliate:a,
      challenges:admin_desc_(sheet_findRows('Challenges',{user_id:u.user_id}),'created_at').map(chal_pub_),
      payments:admin_desc_(sheet_findRows('Payments',{user_id:u.user_id}),'created_at').slice(0,50).map(pay_out_),
      payouts:admin_desc_(sheet_findRows('Payouts',{user_id:u.user_id}),'requested_at').slice(0,50).map(payout_pub_),
      tickets:admin_desc_(sheet_findRows('SupportTickets',{user_id:u.user_id}),'created_at').slice(0,20)};
  }
  if(p.status&&['active','restricted','banned'].indexOf(p.status)<0)throw admin_bad_('Unknown status.');
  if(p.role&&['owner','admin','trader'].indexOf(p.role)<0)throw admin_bad_('Unknown role.');
  var all=sheet_readAll('Users'),counts=admin_count_(all,function(u){return u.status;});
  var rows=all.filter(function(u){
    return (!p.status||u.status===p.status)&&(!p.role||u.role===p.role)&&admin_has_(p.q,[u.email,u.full_name,u.phone,u.user_id]);
  });
  var lim=admin_limit_(p.limit,100,200);
  return {total_matching:rows.length,counts:counts,
    users:admin_desc_(rows,'created_at').slice(0,lim).map(function(u){
      return {user_id:u.user_id,email:u.email,phone:u.phone,full_name:u.full_name,role:u.role,status:u.status,country:u.country,ref_used:u.ref_used,
        created_at:u.created_at,last_login_at:u.last_login_at,locked:!!(u.locked_until&&Date.parse(u.locked_until)>Date.now())};
    })};
}
// status: active | restricted | banned (restricted and banned need a reason). unlock:true clears a login lockout.
function admin_usersUpdate(p,ctx){
  admin_need_(ctx);p=p||{};
  var status=p.status===undefined?null:String(p.status);
  if(status!==null&&['active','restricted','banned'].indexOf(status)<0)throw admin_bad_('status must be active, restricted or banned.');
  if(status===null&&p.unlock!==true)throw admin_bad_('Nothing to change.');
  var reason=(status==='restricted'||status==='banned')?pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).'):'';
  return util_withLock_(function(){
    var u=sheet_getByKey('Users',String(p.target_user_id||''));
    if(!u)throw admin_bad_('User not found.');
    if(u.user_id===ctx.user.user_id)throw admin_bad_('You cannot change your own account here.');
    if(u.role==='owner')throw util_error_(CODES.FORBIDDEN,'The owner account cannot be changed.');
    if(u.role==='admin'&&ctx.role!=='owner')throw util_error_(CODES.FORBIDDEN,'Only the owner can change an admin.');
    var ch={updated_at:util_nowIso_()};
    if(status!==null)ch.status=status;
    if(p.unlock===true){ch.failed_logins=0;ch.locked_until='';}
    var row=sheet_updateRow('Users',u,ch);
    if(status==='banned')auth_revokeUser_(u.user_id); // so reinstating later cannot revive old logins
    if(status!==null&&status!==u.status)settings_audit_(ctx,'user.'+status,'Users',u.user_id,'status',u.status,status,reason);
    if(p.unlock===true)settings_audit_(ctx,'user.unlock','Users',u.user_id,'locked_until',u.locked_until,'');
    return {user:admin_safeUser_(row)};
  });
}
// Owner only. new_role: admin | trader. There is exactly one owner and it cannot be changed here.
function admin_rolesSet(p,ctx){
  if(!ctx||!ctx.user||ctx.role!=='owner')throw util_error_(CODES.FORBIDDEN,'Only the owner can change roles.');
  p=p||{};
  var to=String(p.new_role||'');
  if(['admin','trader'].indexOf(to)<0)throw admin_bad_('new_role must be admin or trader.');
  return util_withLock_(function(){
    var u=sheet_getByKey('Users',String(p.target_user_id||''));
    if(!u)throw admin_bad_('User not found.');
    if(u.user_id===ctx.user.user_id||u.role==='owner')throw admin_bad_('The owner role cannot be changed.');
    if(to==='admin'&&u.status!=='active')throw admin_bad_('Only an active user can become an admin.');
    if(u.role===to)return {user:admin_safeUser_(u)};
    var row=sheet_updateRow('Users',u,{role:to,updated_at:util_nowIso_()});
    auth_revokeUser_(u.user_id); // they sign in again with the new access
    settings_audit_(ctx,'user.role','Users',u.user_id,'role',u.role,to);
    return {user:admin_safeUser_(row)};
  });
}

// ---- Countries and routes ----
// No country_code = the list (q, gateway filters). With one = change gateway, currency or enabled.
// A currency needs an exchange rate first. Enabling a country that is disabled by default (sanctions list) is owner only.
function admin_countriesSave(p,ctx){
  admin_need_(ctx);p=p||{};
  var gws=['squad','monnify','flutterwave','manual'];
  if(!p.country_code){
    if(p.gateway&&gws.indexOf(p.gateway)<0)throw admin_bad_('Unknown gateway.');
    var rows=sheet_readAll('Countries').filter(function(c){return (!p.gateway||c.gateway===p.gateway)&&admin_has_(p.q,[c.country_code,c.name]);});
    return {gateways:gws,currencies:sheet_readAll('FxRates').map(function(r){return r.currency;}),
      countries:rows.map(function(c){return {country_code:c.country_code,name:c.name,gateway:c.gateway,currency:c.currency,enabled:c.enabled,
        restricted_by_default:SHEET_DISABLED_COUNTRIES_.indexOf(c.country_code)>=0};})};
  }
  var code=util_normalizeCountry_(p.country_code);
  return util_withLock_(function(){
    var c=code?sheet_getByKey('Countries',code):null;
    if(!c)throw admin_bad_('Country not found.');
    var ch={},log=[];
    if(p.gateway!==undefined){
      if(gws.indexOf(p.gateway)<0)throw admin_bad_('gateway must be one of: '+gws.join(', ')+'.');
      if(p.gateway!==c.gateway){ch.gateway=p.gateway;log.push(['gateway',c.gateway,p.gateway]);}
    }
    if(p.currency!==undefined){
      var cur=String(p.currency).trim().toUpperCase();
      if(!/^[A-Z]{3}$/.test(cur))throw admin_bad_('currency must be a 3-letter code.');
      if(cur!=='USD'&&!sheet_getByKey('FxRates',cur))throw admin_bad_('Set an exchange rate for '+cur+' first.');
      if(cur!==c.currency){ch.currency=cur;log.push(['currency',c.currency,cur]);}
    }
    if(p.enabled!==undefined){
      if(typeof p.enabled!=='boolean')throw admin_bad_('enabled must be true or false.');
      if(p.enabled&&!c.enabled&&SHEET_DISABLED_COUNTRIES_.indexOf(c.country_code)>=0&&ctx.role!=='owner')
        throw util_error_(CODES.FORBIDDEN,'Only the owner can enable a restricted country.');
      if(p.enabled!==c.enabled){ch.enabled=p.enabled;log.push(['enabled',c.enabled,p.enabled]);}
    }
    if(!log.length)return {country:c,changed:0};
    var row=sheet_updateRow('Countries',c,ch);
    log.forEach(function(l){settings_audit_(ctx,'country.update','Countries',c.country_code,l[0],l[1],l[2]);});
    settings_clear_();
    return {country:row,changed:log.length};
  });
}

// ---- Challenges and review ----
function admin_challengeRow_(ch,users,accts,breaches){
  var a=accts[ch.current_account_id]||null,b=breaches[ch.challenge_id]||null;
  return {challenge_id:ch.challenge_id,user_id:ch.user_id,email:(users[ch.user_id]||{}).email||'',full_name:(users[ch.user_id]||{}).full_name||'',
    plan_id:ch.plan_id,style:ch.style,account_size_usd:ch.account_size_usd,stage:ch.stage,status:ch.status,payouts_paid:ch.payouts_paid||0,
    login:a?a.login:'',start_balance:a?a.start_balance:null,last_balance:a?a.last_balance:null,last_equity:a?a.last_equity:null,
    last_update_at:a?a.last_update_at:'',updated_ago:a&&a.last_update_at?util_timeAgo_(a.last_update_at):'',
    created_at:ch.created_at,funded_at:ch.funded_at,breached_at:ch.breached_at,
    breach:b?{rule:b.rule,actual_value:b.actual_value,allowed_value:b.allowed_value,occurred_at:b.occurred_at,evidence:b.evidence,admin_note:b.admin_note}:null};
}
function admin_challengesList(p,ctx){
  admin_need_(ctx);p=p||{};
  var users=admin_userMap_(),accts={},breaches={};
  sheet_readAll('Accounts').forEach(function(a){accts[a.account_id]=a;});
  admin_desc_(sheet_readAll('BreachLog'),'occurred_at').forEach(function(b){if(!breaches[b.challenge_id])breaches[b.challenge_id]=b;});
  if(p.challenge_id){
    var ch=chal_get_(String(p.challenge_id));
    return {challenge:admin_challengeRow_(ch,users,accts,breaches),status_history:chal_history_(ch),
      accounts:sheet_findRows('Accounts',{challenge_id:ch.challenge_id}).map(function(a){
        return {account_id:a.account_id,stage:a.stage,status:a.status,login:a.login,size_usd:a.size_usd,start_balance:a.start_balance,last_balance:a.last_balance,
          last_equity:a.last_equity,last_update_at:a.last_update_at,assigned_at:a.assigned_at,closed_at:a.closed_at,close_reason:a.close_reason};}),
      breaches:admin_desc_(sheet_findRows('BreachLog',{challenge_id:ch.challenge_id}),'occurred_at'),
      payments:sheet_findRows('Payments',{challenge_id:ch.challenge_id}).map(pay_out_),
      payouts:sheet_findRows('Payouts',{challenge_id:ch.challenge_id}).map(payout_pub_)};
  }
  if(p.stage&&['Phase 1','Phase 2','Funded'].indexOf(p.stage)<0)throw admin_bad_('Unknown stage.');
  if(p.status&&['Active','Passed','Breached'].indexOf(p.status)<0)throw admin_bad_('Unknown status.');
  var all=sheet_readAll('Challenges'),logins={};
  Object.keys(accts).forEach(function(k){(logins[accts[k].challenge_id]=logins[accts[k].challenge_id]||[]).push(accts[k].login);});
  var rows=all.filter(function(c){
    return (!p.stage||c.stage===p.stage)&&(!p.status||c.status===p.status)&&
      admin_has_(p.q,[c.challenge_id,(users[c.user_id]||{}).email,(users[c.user_id]||{}).full_name].concat(logins[c.challenge_id]||[]));
  });
  return {total_matching:rows.length,counts:admin_count_(all,function(c){return c.stage+'|'+c.status;}),
    challenges:admin_desc_(rows,'created_at').slice(0,admin_limit_(p.limit,100,200)).map(function(c){return admin_challengeRow_(c,users,accts,breaches);})};
}
// decision: pass (reason) | breach (reason, optional rule, actual_value, allowed_value, occurred_at, evidence) | activate
// (opens the next account for a passed challenge that was waiting for stock). Equity uploads and automatic checks are Part 17.
function admin_challengeReview(p,ctx){
  admin_need_(ctx);p=p||{};
  var id=String(p.challenge_id||''),d=String(p.decision||'');
  chal_get_(id);
  var out;
  if(d==='pass'){
    var why=pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).');
    out=chal_passStage(id,{user:ctx.user,role:ctx.role,note:'Manual pass: '+why});
    settings_audit_(ctx,'challenge.pass','Challenges',id,'status','Active','Passed',why);
  }else if(d==='breach'){
    var reason=pay_text_(p.reason,3,300,'A reason is required (3 to 300 characters).');
    var evidence=p.evidence===undefined||p.evidence===null?'':pay_text_(String(p.evidence),0,500,'Evidence must be 500 characters or fewer.');
    out=chal_breachStage(id,{rule:p.rule||'manual',actual_value:p.actual_value,allowed_value:p.allowed_value,occurred_at:p.occurred_at,
      evidence:evidence,admin_note:reason},{user:ctx.user,role:ctx.role});
    if(!out.already)settings_audit_(ctx,'challenge.breach','Challenges',id,'status','Active','Breached',reason);
  }else if(d==='activate'){
    out=chal_activateNext(id,{user:ctx.user,role:ctx.role});
    settings_audit_(ctx,'challenge.activate','Challenges',id,'status','Passed',out.waiting_for_account?'Passed':'Active');
  }else throw admin_bad_('decision must be pass, breach or activate.');
  var ch=chal_get_(id);
  return {challenge:chal_pub_(ch),waiting_for_account:!!out.waiting_for_account,already:!!out.already};
}

// ---- Support tickets (Part 18): the trader side lives below in support_create/support_listMine ----
// status: open (default) | answered | closed | all. A reply also lets the trader see it in Alerts (announced by notify_scan).
function admin_supportList(p,ctx){
  admin_need_(ctx);p=p||{};
  var st=String(p.status||'open');if(['open','answered','closed','all'].indexOf(st)<0)throw admin_bad_('status must be open, answered, closed or all.');
  var users={};sheet_readAll('Users').forEach(function(u){users[u.user_id]=u;});
  var rows=sheet_readAll('SupportTickets').filter(function(t){return st==='all'||t.status===st;});
  rows.sort(function(a,b){return String(b.created_at).localeCompare(String(a.created_at));});
  return {tickets:rows.slice(0,200).map(function(t){var u=users[t.user_id]||{};
    return {ticket_id:t.ticket_id,email:u.email||'',name:u.full_name||'',subject:t.subject,message:t.message,status:t.status,admin_reply:t.admin_reply||'',created_at:t.created_at,replied_at:t.replied_at||''};})};
}
function admin_supportReply(p,ctx){
  admin_need_(ctx);p=p||{};
  var id=String(p.ticket_id||''),reply=pay_text_(p.reply,2,2000,'A reply is required (2 to 2000 characters).'),close=p.close===true;
  return util_withLock_(function(){
    var t=sheet_findRows('SupportTickets',{ticket_id:id})[0];
    if(!t)throw admin_bad_('Ticket not found.');
    if(t.status==='closed')throw admin_bad_('This ticket is closed.');
    var now=util_nowIso_(),next=close?'closed':'answered';
    sheet_updateRows('SupportTickets',[{target:t,changes:{admin_reply:reply,status:next,replied_at:now,updated_at:now}}]);
    settings_audit_(ctx,'support.reply','SupportTickets',id,'status',t.status,next);
    return {ticket_id:id,status:next,replied_at:now};
  });
}

// ---- Crypto orders and receiving addresses ----
// Part 12 keeps crypto_* functions out of the whitelist on purpose (its test enforces it), so the admin actions
// reach them through these wrappers. All checks and audit rows stay in the Part 12 functions.
function admin_cryptoList(p,ctx){admin_need_(ctx);return crypto_adminList(p,ctx);}
function admin_cryptoApprove(p,ctx){admin_need_(ctx);return crypto_adminApprove(p,ctx);}
function admin_cryptoReject(p,ctx){admin_need_(ctx);return crypto_adminReject(p,ctx);}
function admin_addressesSave(p,ctx){admin_need_(ctx);return crypto_saveAddresses(p,ctx);}

// ---- Payments ----
function admin_paymentsList(p,ctx){
  admin_need_(ctx);p=p||{};
  if(p.status&&Object.keys(PAY_TRANSITIONS_).indexOf(p.status)<0)throw admin_bad_('Unknown status.');
  if(p.gateway&&['squad','monnify','flutterwave','manual'].indexOf(p.gateway)<0)throw admin_bad_('Unknown gateway.');
  var users=admin_userMap_(),all=sheet_readAll('Payments');
  var rows=all.filter(function(o){
    return (!p.status||o.status===p.status)&&(!p.gateway||o.gateway===p.gateway)&&
      admin_has_(p.q,[o.order_ref,o.txid,o.gateway_ref,o.billing_email,(users[o.user_id]||{}).email,o.ref_code]);
  });
  return {total_matching:rows.length,counts:admin_count_(all,function(o){return o.status;}),
    payments:admin_desc_(rows,'created_at').slice(0,admin_limit_(p.limit,100,200)).map(function(o){
      return Object.assign(pay_out_(o),admin_brief_(users[o.user_id]),{user_id:o.user_id,ref_code:o.ref_code,gateway_ref:o.gateway_ref,
        confirmed_at:o.confirmed_at,confirmed_by:o.confirmed_by,refunded_at:o.refunded_at,status_history:pay_history_(o)});
    })};
}
// Only a confirmed payment with no account issued can be refunded (Part 11 rule). The affiliate commission is cancelled by the hook.
function admin_paymentsRefund(p,ctx){
  admin_need_(ctx);p=p||{};
  return {payment:pay_out_(pay_refund(String(p.order_ref||''),p.reason,ctx))};
}

// ---- Breach log and audit log ----
function admin_breachesList(p,ctx){
  admin_need_(ctx);p=p||{};
  var users=admin_userMap_();
  var rows=sheet_readAll('BreachLog').filter(function(b){
    return (!p.challenge_id||b.challenge_id===p.challenge_id)&&(!p.rule||b.rule===String(p.rule).toLowerCase())&&
      admin_has_(p.q,[b.login,b.challenge_id,(users[b.user_id]||{}).email]);
  });
  return {total_matching:rows.length,breaches:admin_desc_(rows,'occurred_at').slice(0,admin_limit_(p.limit,100,200)).map(function(b){
    return Object.assign({},b,admin_brief_(users[b.user_id]));})};
}
// Newest first. action matches the start of the action name (for example "payout."). from and to are ISO times.
function admin_auditList(p,ctx){
  admin_need_(ctx);p=p||{};
  var from=p.from?Date.parse(p.from):-Infinity,to=p.to?Date.parse(p.to):Infinity;
  if(isNaN(from)||isNaN(to))throw admin_bad_('from and to must be valid times.');
  var users=admin_userMap_(),act=p.action?String(p.action).toLowerCase():'';
  var rows=sheet_readAll('AuditLog').filter(function(r){
    var at=Date.parse(r.at);
    return at>=from&&at<=to&&(!act||String(r.action).toLowerCase().indexOf(act)===0)&&(!p.entity||r.entity===p.entity)&&
      (!p.entity_id||r.entity_id===p.entity_id)&&(!p.actor||r.actor_user_id===p.actor)&&
      admin_has_(p.q,[r.action,r.entity_id,r.field,r.note,r.new_value]);
  });
  var lim=admin_limit_(p.limit,100,500),off=Math.max(0,Math.floor(Number(p.offset))||0),sorted=admin_desc_(rows,'at');
  return {total_matching:rows.length,offset:off,entries:sorted.slice(off,off+lim).map(function(r){
    return Object.assign({},r,{_row:undefined,actor_email:(users[r.actor_user_id]||{}).email||''});})};
}

// ---- Test: editor only, throwaway spreadsheet. Run admin_runTests from the Apps Script editor. ----
function admin_runTests(){
  var ss=SpreadsheetApp.create('RAVEN-ADMIN-TEST'),bad=[];
  var owner={user:{user_id:'U-OWN'},role:'owner'},adm={user:{user_id:'U-ADM'},role:'admin'},tr={user:{user_id:'U-T1'},role:'trader'};
  function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  function fails(f,text){try{f();}catch(e){if(text&&String(e.message).indexOf(text)<0)throw new Error('wrong message: '+e.message);return;}throw new Error('should have failed');}
  function user(id,extra){sheet_appendRow('Users',Object.assign({user_id:id,email:id.toLowerCase()+'@t.com',phone:'',full_name:'Name '+id,password_hash:'pbkdf2-sha256$1$aa$bb',role:'trader',status:'active',country:'NG',created_at:util_nowIso_()},extra||{}));}
  function audit(a){return sheet_findRows('AuditLog',{action:a}).length;}
  var seq=0;
  function order(uid,extra){var ref='RV-A-'+(++seq);sheet_appendRow('Payments',Object.assign({order_ref:ref,user_id:uid,plan_id:'swift-10000',gateway:'manual',country:'NG',status:'awaiting_confirmation',list_fee_usd:100,amount_usd:100,currency:'USD',created_at:util_nowIso_()},extra||{}));return ref;}
  function challenge(id,uid,extra){
    var now=util_nowIso_();
    sheet_appendRow('AccountPool',{pool_id:'P-'+id,size_usd:10000,login:'8'+id.replace(/\D/g,'').padStart(7,'0'),password:'pw12345',investor_password:'inv12345',server:'S1',status:'Assigned',challenge_id:id});
    sheet_appendRow('Challenges',Object.assign({challenge_id:id,user_id:uid,plan_id:'swift-10000',style:'Swift',account_size_usd:10000,stage:'Phase 1',status:'Active',current_account_id:'A-'+id,payouts_paid:0,created_at:now},extra||{}));
    sheet_appendRow('Accounts',{account_id:'A-'+id,challenge_id:id,user_id:uid,stage:'Phase 1',pool_id:'P-'+id,login:'8'+id.replace(/\D/g,'').padStart(7,'0'),size_usd:10000,start_balance:10000,status:'Active',last_balance:10500,last_equity:10450,last_update_at:now,assigned_at:now});
  }
  try{
    sheet_buildAll_(ss);settings_clear_();
    user('U-OWN',{role:'owner',email:'owner@t.com'});user('U-ADM',{role:'admin'});user('U-ADM2',{role:'admin'});
    user('U-T1');user('U-T2',{email:'ada@t.com',full_name:'Ada Obi',phone:'+2348011112222'});user('U-T3');

    t('every admin action is wired',function(){
      var missing=[];
      Object.keys(ACTIONS).forEach(function(k){var a=ACTIONS[k];if((a.level==='admin'||a.level==='owner')&&typeof globalThis[a.fn]!=='function')missing.push(k);});
      missing=missing.filter(function(k){return k!=='admin.equity.upload';}); // Part 17
      util_assertEq_(missing.join(','),'','unwired admin actions');
      Object.keys(ACTIONS).forEach(function(k){util_assert_(ACTIONS[k].fn.indexOf('crypto_')!==0||ACTIONS[k].fn==='crypto_submitTxid','crypto_* stays out of the whitelist: '+k);});
      util_assertEq_(ACTIONS['admin.payments.refund'].level,'admin','refund is an admin action');
    });
    t('non-admins are refused everywhere',function(){
      ['admin_overview','admin_usersList','admin_usersUpdate','admin_countriesSave','admin_challengesList','admin_challengeReview','admin_paymentsList','admin_paymentsRefund','admin_breachesList','admin_auditList'].forEach(function(f){
        fails(function(){globalThis[f]({},tr);},'access');fails(function(){globalThis[f]({},{});},'access');
      });
      fails(function(){admin_rolesSet({target_user_id:'U-T1',new_role:'admin'},adm);},'owner');
      ['admin_cryptoList','admin_cryptoApprove','admin_cryptoReject','admin_addressesSave'].forEach(function(f){fails(function(){globalThis[f]({},tr);},'access');});
    });
    t('crypto wrappers reach the Part 12 functions',function(){
      util_assertEq_(admin_cryptoList({},adm).orders.length,0,'queue');util_assertEq_(admin_addressesSave({},adm).addresses.length,0,'addresses');
      fails(function(){admin_cryptoReject({order_ref:'RV-NOPE',reason:'abc'},adm);},'not found');
    });

    t('users: search, detail, no secrets',function(){
      var r=admin_usersList({q:'ada'},adm);util_assertEq_(r.users.length,1,'search by name');util_assertEq_(r.users[0].user_id,'U-T2','found');
      util_assertEq_(admin_usersList({q:'2348011112222'},adm).users.length,1,'search by phone');
      util_assertEq_(admin_usersList({role:'admin'},adm).total_matching,2,'role filter');
      var d=admin_usersList({target_user_id:'U-T2'},adm),s=JSON.stringify(d)+JSON.stringify(r);
      util_assert_(s.indexOf('password_hash')<0&&s.indexOf('pbkdf2')<0&&s.indexOf('reset_token')<0,'no hashes');
      fails(function(){admin_usersList({target_user_id:'U-NOPE'},adm);},'not found');fails(function(){admin_usersList({status:'x'},adm);},'status');
    });
    t('users: restrict, ban, unlock, and their limits',function(){
      fails(function(){admin_usersUpdate({target_user_id:'U-T1',status:'banned'},adm);},'reason');
      fails(function(){admin_usersUpdate({target_user_id:'U-T1',status:'gone',reason:'abc'},adm);},'status');
      fails(function(){admin_usersUpdate({target_user_id:'U-ADM',status:'banned',reason:'abc'},adm);},'own account');
      fails(function(){admin_usersUpdate({target_user_id:'U-OWN',status:'banned',reason:'abc'},adm);},'owner');
      fails(function(){admin_usersUpdate({target_user_id:'U-ADM2',status:'banned',reason:'abc'},adm);},'Only the owner');
      var tok=auth_startSession_('U-T3').token;util_assert_(!!auth_resolveSession(tok),'session works');
      admin_usersUpdate({target_user_id:'U-T3',status:'restricted',reason:'Suspicious activity'},adm);
      util_assertEq_(sheet_getByKey('Users','U-T3').status,'restricted','restricted');
      fails(function(){pay_createOrder({plan_id:'swift-10000',country:'NG',billing_name:'A B'},{user:{user_id:'U-T3'},role:'trader'});},'cannot place orders');
      admin_usersUpdate({target_user_id:'U-T3',status:'banned',reason:'Fraud'},adm);
      util_assertEq_(auth_resolveSession(tok),null,'banned user is signed out');
      admin_usersUpdate({target_user_id:'U-T3',status:'active'},adm);util_assertEq_(sheet_getByKey('Users','U-T3').status,'active','reinstated without a reason');
      util_assertEq_(auth_resolveSession(tok),null,'the old login does not come back to life');
      sheet_updateRow('Users','U-T3',{failed_logins:5,locked_until:new Date(Date.now()+9e5).toISOString()});
      util_assertEq_(admin_usersList({q:'u-t3'},adm).users[0].locked,true,'locked shown');
      admin_usersUpdate({target_user_id:'U-T3',unlock:true},adm);util_assertEq_(admin_usersList({q:'u-t3'},adm).users[0].locked,false,'unlocked');
      util_assertEq_(admin_usersUpdate({target_user_id:'U-ADM2',status:'restricted',reason:'Testing'},owner).user.status,'restricted','owner may change an admin');
      util_assert_(audit('user.banned')===1&&audit('user.restricted')===2&&audit('user.unlock')===1,'audited');
    });
    t('roles: owner only, one owner',function(){
      fails(function(){admin_rolesSet({target_user_id:'U-T1',new_role:'owner'},owner);},'admin or trader');
      fails(function(){admin_rolesSet({target_user_id:'U-OWN',new_role:'trader'},owner);},'owner role');
      fails(function(){admin_rolesSet({target_user_id:'U-ADM2',new_role:'admin'},owner);},'active');
      var tok=auth_startSession_('U-T1').token;
      function call(a,tk){return router_handle_({postData:{contents:JSON.stringify({action:a,token:tk,payload:{}})}});}
      util_assertEq_(call('admin.overview',tok).code,'FORBIDDEN','trader blocked by the router');
      admin_rolesSet({target_user_id:'U-T1',new_role:'admin'},owner);
      util_assertEq_(call('admin.overview',auth_startSession_('U-T1').token).ok,true,'new admin gets in after signing in again');
      admin_rolesSet({target_user_id:'U-T1',new_role:'trader'},owner);
      util_assertEq_(call('admin.overview',auth_startSession_('U-T1').token).code,'FORBIDDEN','demoted');
      util_assertEq_(audit('user.role'),2,'audited');
    });
    t('role in the body cannot be smuggled',function(){
      var tok=auth_startSession_('U-T2').token,r=router_handle_({postData:{contents:JSON.stringify({action:'admin.roles.set',token:tok,payload:{target_user_id:'U-T2',new_role:'admin',role:'owner'}})}});
      util_assertEq_(r.code,'FORBIDDEN','a trader cannot reach it');
      util_assertEq_(sheet_getByKey('Users','U-T2').role,'trader','still a trader');
    });

    t('countries: list, route change, guards',function(){
      var l=admin_countriesSave({q:'nigeria'},adm);util_assertEq_(l.countries.length,1,'search');util_assertEq_(l.countries[0].gateway,'squad','Nigeria on Squad');
      fails(function(){admin_countriesSave({country_code:'GH',currency:'GHS'},adm);},'exchange rate');
      fails(function(){admin_countriesSave({country_code:'GH',gateway:'paypal'},adm);},'gateway');
      fails(function(){admin_countriesSave({country_code:'GH',enabled:'yes'},adm);},'true or false');
      fails(function(){admin_countriesSave({country_code:'ZZ',enabled:true},adm);},'not found');
      fails(function(){admin_countriesSave({country_code:'US',enabled:true},adm);},'owner');
      util_assertEq_(admin_countriesSave({country_code:'US',enabled:true},owner).country.enabled,true,'owner enables a restricted country');
      var r=admin_countriesSave({country_code:'GH',gateway:'manual'},adm);util_assertEq_(r.changed,1,'changed');
      util_assertEq_(settings_getCountry('GH').gateway,'manual','the public route sees it at once');
      util_assertEq_(admin_countriesSave({country_code:'GH',gateway:'manual'},adm).changed,0,'no change, no audit');
      util_assertEq_(audit('country.update'),2,'audited');
    });

    t('challenges: list, detail, filters',function(){
      challenge('C-100','U-T2');challenge('C-200','U-T3',{stage:'Funded'});
      var l=admin_challengesList({},adm);util_assertEq_(l.total_matching,2,'two');util_assertEq_(l.challenges.filter(function(c){return c.challenge_id==='C-100';})[0].email,'ada@t.com','joined email');
      util_assertEq_(admin_challengesList({q:'ada'},adm).total_matching,1,'search by trader');
      util_assertEq_(admin_challengesList({q:'80000100'},adm).total_matching,1,'search by MT5 login');
      util_assertEq_(admin_challengesList({stage:'Funded'},adm).challenges[0].challenge_id,'C-200','stage filter');
      var d=admin_challengesList({challenge_id:'C-100'},adm),s=JSON.stringify(d);
      util_assert_(s.indexOf('inv12345')<0&&s.indexOf('pw12345')<0&&s.indexOf('investor')<0,'no passwords');
      util_assertEq_(d.accounts.length,1,'accounts');
    });
    t('review: pass, wait for stock, activate',function(){
      fails(function(){admin_challengeReview({challenge_id:'C-100',decision:'pass'},adm);},'reason');
      fails(function(){admin_challengeReview({challenge_id:'C-100',decision:'maybe'},adm);},'decision');
      fails(function(){admin_challengeReview({challenge_id:'C-NOPE',decision:'pass',reason:'abc'},adm);},'not found');
      var r=admin_challengeReview({challenge_id:'C-100',decision:'pass',reason:'Target reached, checked on MT5'},adm);
      util_assertEq_(r.challenge.status+'|'+r.waiting_for_account,'Passed|true','no stock: waits');
      sheet_appendRow('AccountPool',{pool_id:'P-NEW1',size_usd:10000,login:'70000001',password:'pw2',investor_password:'inv2',server:'S1',status:'Available'});
      var a=admin_challengeReview({challenge_id:'C-100',decision:'activate'},adm);
      util_assertEq_(a.challenge.stage+'|'+a.challenge.status,'Phase 2|Active','next account assigned');
      fails(function(){admin_challengeReview({challenge_id:'C-100',decision:'activate'},adm);},'not waiting');
      util_assert_(audit('challenge.pass')===1&&audit('challenge.activate')===1,'audited');
      util_assert_(JSON.stringify(sheet_getByKey('Challenges','C-100').status_history).indexOf('Manual pass')>=0,'reason kept in history');
    });
    t('review: breach with reason and evidence',function(){
      fails(function(){admin_challengeReview({challenge_id:'C-200',decision:'breach'},adm);},'reason');
      var r=admin_challengeReview({challenge_id:'C-200',decision:'breach',reason:'Daily loss exceeded 3%',rule:'daily_loss',actual_value:9600,allowed_value:9700,evidence:'MT5 statement 28 Sep'},adm);
      util_assertEq_(r.challenge.status,'Breached','breached');
      var b=sheet_findOne('BreachLog',{challenge_id:'C-200'});
      util_assertEq_(b.rule+'|'+b.actual_value+'|'+b.evidence+'|'+b.admin_note,'daily_loss|9600|MT5 statement 28 Sep|Daily loss exceeded 3%','full record');
      util_assertEq_(admin_challengeReview({challenge_id:'C-200',decision:'breach',reason:'again'},adm).already,true,'repeat is harmless');
      util_assertEq_(sheet_findRows('BreachLog',{challenge_id:'C-200'}).length,1,'one record');
      fails(function(){admin_challengeReview({challenge_id:'C-200',decision:'pass',reason:'oops'},adm);},'active');
      util_assertEq_(audit('challenge.breach'),1,'audited once');
      var l=admin_breachesList({},adm);util_assertEq_(l.breaches.length,1,'breach log');util_assertEq_(l.breaches[0].email,'u-t3@t.com','joined');
      util_assertEq_(admin_breachesList({rule:'max_loss'},adm).breaches.length,0,'rule filter');
      util_assertEq_(admin_challengesList({challenge_id:'C-200'},adm).challenge.breach.rule,'daily_loss','breach shown on the challenge');
    });

    t('payments: list, filters, refund',function(){
      var a=order('U-T2',{gateway:'manual',txid:'TXABC12345',status:'awaiting_confirmation'}),b=order('U-T2',{status:'confirmed',confirmed_at:util_nowIso_()}),c=order('U-T3',{gateway:'squad',status:'challenge_created',challenge_id:'C-100',confirmed_at:util_nowIso_()});
      util_assertEq_(admin_paymentsList({status:'confirmed'},adm).payments.length,1,'status filter');
      util_assertEq_(admin_paymentsList({q:'txabc12345'},adm).payments[0].order_ref,a,'search by TXID');
      util_assertEq_(admin_paymentsList({gateway:'squad'},adm).payments[0].email,'u-t3@t.com','joined email');
      fails(function(){admin_paymentsList({status:'bogus'},adm);},'status');
      fails(function(){admin_paymentsRefund({order_ref:b},adm);},'reason');
      fails(function(){admin_paymentsRefund({order_ref:c,reason:'Customer asked'},adm);},'cannot move');
      util_assertEq_(admin_paymentsRefund({order_ref:b,reason:'Customer asked before account'},adm).payment.status,'refunded','refunded');
      fails(function(){admin_paymentsRefund({order_ref:b,reason:'Twice'},adm);},'cannot move');
      util_assertEq_(audit('payment.refund'),1,'audited');
    });
    t('overview',function(){
      var o=admin_overview({},adm);
      util_assertEq_(o.revenue.all_time_usd,100,'only paid orders count: the refunded and unpaid ones do not');
      util_assertEq_(o.revenue.refunded_usd,100,'refunds shown separately');
      util_assertEq_(o.pending.crypto_orders,1,'crypto order waiting');util_assertEq_(o.orders.refunded,1,'order counts');
      util_assertEq_(o.challenges.active,1,'active challenges');util_assert_(o.users.total>=6,'users counted');
      util_assert_(Array.isArray(o.pool.stock)&&o.attention.some(function(x){return x.key==='crypto_orders'&&x.count===1;}),'attention list');
      sheet_appendRow('Payouts',{payout_id:'PO-1',challenge_id:'C-100',user_id:'U-T2',status:'Submitted',requested_at:util_nowIso_(),amount_usd:250});
      var p=admin_overview({},adm);util_assertEq_(p.payouts.open,1,'open payout');util_assertEq_(p.payouts.open_usd,250,'open payout value');
      util_assert_(JSON.stringify(p).indexOf('inv12345')<0,'no pool passwords');
    });
    t('audit log: filters and paging',function(){
      var all=admin_auditList({},adm);util_assert_(all.total_matching>10,'has entries');
      util_assertEq_(all.entries[0].at>=all.entries[all.entries.length-1].at,true,'newest first');
      var f=admin_auditList({action:'user.'},adm);util_assert_(f.entries.length>=6&&f.entries.every(function(e){return e.action.indexOf('user.')===0;}),'prefix filter');
      util_assertEq_(f.entries[0].actor_email!==undefined,true,'actor email joined');
      util_assertEq_(admin_auditList({action:'user.',limit:2},adm).entries.length,2,'limit');
      util_assertEq_(admin_auditList({action:'user.',limit:2,offset:2},adm).entries[0].audit_id!==f.entries[0].audit_id,true,'offset moves on');
      util_assertEq_(admin_auditList({limit:99999},adm).entries.length<=500,true,'limit is capped');
      util_assertEq_(admin_auditList({entity:'Countries'},adm).total_matching,2,'entity filter');
      util_assertEq_(admin_auditList({from:'2999-01-01T00:00:00Z'},adm).total_matching,0,'time filter');
      fails(function(){admin_auditList({from:'nonsense'},adm);},'valid times');
    });
  }finally{
    sheet_setSpreadsheet_(null);settings_clear_();
    try{DriveApp.getFileById(ss.getId()).setTrashed(true);}catch(e){}
  }
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 16 TESTS PASSED');
}

// ===== PART 17: EQUITY ENDPOINT AND MONITORING =====
// Three entry points feed one core (equity_process_):
//   admin.equity.upload  admin CSV upload or typed entry (session + admin role)
//   equity.ingest        the monitor script posts batches (secret key in the body, EQUITY_SECRET in Script Properties)
//   equity.accounts      the monitor fetches active logins + investor passwords (same secret). Never log the response.
// The core recalculates through Part 9 (rules_evaluate) and moves the challenge through Part 10.
var EQUITY_MAX_ROWS_ = 500;
function equity_bad_(m){return util_error_(CODES.BAD_REQUEST,m);}
function equity_checkSecret_(p){
  var want=PropertiesService.getScriptProperties().getProperty('EQUITY_SECRET')||'';
  var got=p&&typeof p.secret==='string'?p.secret:'';
  if(want.length<24)throw util_error_(CODES.FORBIDDEN,'The equity endpoint is not configured.');
  var diff=want.length^got.length;
  for(var i=0;i<want.length;i++)diff|=want.charCodeAt(i)^(got.charCodeAt(i%Math.max(got.length,1))||0);
  if(diff!==0)throw util_error_(CODES.FORBIDDEN,'Not allowed.');
}
function equity_num_(v,name,min){
  if(v===null||v===undefined||v===''||typeof v==='boolean')throw equity_bad_(name+' must be a number.');
  var n=Number(typeof v==='string'?v.replace(/[$,\s]/g,''):v);
  if(!isFinite(n)||n<min)throw equity_bad_(name+' must be a number of '+min+' or more.');
  return n;
}
// Validate one raw row. Returns {ok:true,row} or {ok:false,error}. Pure: no sheet access.
function equity_validateRow_(r,nowMs){
  try{
    if(!r||typeof r!=='object')throw equity_bad_('Row is not an object.');
    var login=String(r.login==null?'':r.login).trim();
    if(!/^[0-9]{4,15}$/.test(login))throw equity_bad_('login must be 4-15 digits.');
    var t=util_parseTime_(r.timestamp);
    if(!t)throw equity_bad_('timestamp is not a valid date.');
    if(t.getTime()>nowMs+5*60000)throw equity_bad_('timestamp is in the future.');
    var row={login:login,balance:equity_num_(r.balance,'balance',0),equity:equity_num_(r.equity,'equity',0),timestamp:t.toISOString()};
    var lt=r.last_trade==null||r.last_trade===''?null:util_parseTime_(r.last_trade);
    if(r.last_trade!=null&&r.last_trade!==''&&!lt)throw equity_bad_('last_trade is not a valid date.');
    row.last_trade=lt?lt.toISOString():'';
    row.open_positions=r.open_positions==null||r.open_positions===''?null:equity_num_(r.open_positions,'open_positions',0);
    return {ok:true,row:row};
  }catch(e){return {ok:false,error:e.message,login:r&&r.login!=null?String(r.login).slice(0,20):''};}
}
// CSV: header optional. Columns login, balance, equity, timestamp (last_trade and open_positions optional).
function equity_parseCsv_(text){
  var lines=String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/).filter(function(l){return l.trim();});
  if(!lines.length)throw equity_bad_('The CSV is empty.');
  var cols=['login','balance','equity','timestamp','last_trade','open_positions'];
  var first=lines[0].toLowerCase().split(',').map(function(x){return x.trim();});
  if(first.indexOf('login')>=0){cols=first;lines.shift();}
  return lines.map(function(l,i){var c=l.split(',').map(function(x){return x.trim();}),o={_line:i+1};cols.forEach(function(k,j){if(k)o[k]=c[j];});return o;});
}
function equity_process_(rawRows,source,by,dryRun){
  if(!Array.isArray(rawRows)||!rawRows.length)throw equity_bad_('No rows to process.');
  if(rawRows.length>EQUITY_MAX_ROWS_)throw equity_bad_('Send at most '+EQUITY_MAX_ROWS_+' rows per call.');
  var now=Date.now(),res={received:rawRows.length,updated:0,passed:0,breached:0,warnings:[],skipped:[],errors:[],dry_run:!!dryRun};
  var good=[];
  rawRows.forEach(function(r,i){var v=equity_validateRow_(r,now);if(v.ok){v.row._line=r._line||i+1;good.push(v.row);}else res.errors.push({line:r&&r._line||i+1,login:v.login,error:v.error});});
  if(dryRun||!good.length)return res;
  return util_withLock_(function(){
    var accts={};sheet_findRows('Accounts',{status:'Active'}).forEach(function(a){accts[String(a.login)]=a;});
    var chById={};sheet_readAll('Challenges').forEach(function(c){chById[c.challenge_id]=c;});
    var plans={};sheet_readAll('ChallengePlans').forEach(function(p){plans[p.plan_id]=p;});
    var warnPct=Number(settings_get('drawdown_warning_pct',80))||80;
    var seen={},updates=[],progress=[],todo=[],nowIso=util_nowIso_();
    // keep only the newest row per login in this batch
    good.sort(function(a,b){return a.timestamp<b.timestamp?-1:1;});
    good.forEach(function(r){seen[r.login]=r;});
    Object.keys(seen).forEach(function(login){
      var r=seen[login],a=accts[login];
      if(!a){res.skipped.push({login:login,reason:'no active account with this login'});return;}
      if(a.last_update_at&&Date.parse(a.last_update_at)>Date.parse(r.timestamp)){res.skipped.push({login:login,reason:'older than the last update'});return;}
      var ch=chById[a.challenge_id],plan=ch&&plans[ch.plan_id];
      if(!ch||!plan||ch.status!=='Active'){res.skipped.push({login:login,reason:'challenge is not active'});return;}
      var change={last_balance:r.balance,last_equity:r.equity,last_update_at:r.timestamp};
      if(r.last_trade)change.last_trade_at=r.last_trade;
      var dayStart=rules_dayStart(plan,r.timestamp);
      if(!a.day_start_date||rules_needsDayReset(plan,a.day_start_date,r.timestamp)){change.day_start_balance=r.balance;change.day_start_date=dayStart;}
      var ds=change.day_start_balance!==undefined?change.day_start_balance:a.day_start_balance;
      var verdict=rules_evaluate({plan:plan,stage:a.stage,start_balance:a.start_balance,day_start_balance:ds,balance:r.balance,equity:r.equity,at:r.timestamp,
        open_positions:r.open_positions,last_activity_at:r.last_trade||a.last_trade_at||a.assigned_at,warn_pct:warnPct,evidence:'equity:'+source+':'+login+'@'+r.timestamp});
      updates.push({target:a,changes:change});
      progress.push({login:login,account_id:a.account_id,balance:r.balance,equity:r.equity,timestamp:r.timestamp,last_trade:r.last_trade,source:source,recorded_at:nowIso});
      if(verdict.status!=='active')todo.push({ch:ch,verdict:verdict,login:login});
      else if(verdict.warnings.length)res.warnings.push({login:login,challenge_id:ch.challenge_id,warnings:verdict.warnings});
    });
    // one batched write for every account and snapshot
    sheet_updateRows('Accounts',updates);
    sheet_appendRows('AccountProgress',progress);
    res.updated=updates.length;
    todo.forEach(function(t){
      try{
        if(t.verdict.status==='breached'){var b=t.verdict.breach;
          chal_breachStage(t.ch.challenge_id,{rule:b.rule,actual_value:b.actual_value,allowed_value:b.allowed_value,occurred_at:b.occurred_at,evidence:b.evidence,admin_note:b.reason},{by:by});res.breached++;}
        else{chal_passStage(t.ch.challenge_id,{by:by});res.passed++;}
      }catch(e){res.errors.push({login:t.login,error:'Could not move challenge: '+e.message});}
    });
    return res;
  });
}
// Admin: CSV text, a rows list, or one typed row. dry_run checks without writing.
function admin_equityUpload(p,ctx){
  admin_need_(ctx);p=p||{};
  var rows,source='csv';
  if(typeof p.csv==='string'){if(p.csv.length>2e5)throw equity_bad_('The CSV is too large.');rows=equity_parseCsv_(p.csv);}
  else if(Array.isArray(p.rows))rows=p.rows;
  else if(p.login!==undefined){rows=[{login:p.login,balance:p.balance,equity:p.equity,timestamp:p.timestamp||new Date().toISOString(),last_trade:p.last_trade,open_positions:p.open_positions}];source='manual';}
  else throw equity_bad_('Send csv text, a rows list or one row.');
  var out=equity_process_(rows,source,(ctx.role||'admin')+':'+ctx.user.user_id,!!p.dry_run);
  if(!p.dry_run)settings_audit_(ctx,'equity.'+source,'Accounts','batch','rows','',out.updated,out.breached+' breached, '+out.passed+' passed');
  return out;
}
// Monitor script: batches of rows. Secret goes in the POST body, never in a URL.
function equity_ingest(p,ctx){
  equity_checkSecret_(p);
  return equity_process_(p.rows,'script','equity-script',false);
}
// Monitor script: who to check. Returns investor passwords to the secret holder only.
function equity_accounts(p,ctx){
  equity_checkSecret_(p);
  var pool={};sheet_readAll('AccountPool').forEach(function(r){pool[r.pool_id]=r;});
  return {accounts:sheet_findRows('Accounts',{status:'Active'}).map(function(a){
    var pr=pool[a.pool_id];if(!pr)return null;var d=pool_dec_(pr);
    return {login:String(a.login),server:d.server,investor_password:d.investor_password};
  }).filter(Boolean)};
}
// Daily job: move snapshots older than equity_archive_days (default 60) to the AccountProgressArchive sheet.
function equity_archive(){
  var days=Number(settings_get('equity_archive_days',60))||60,cut=Date.now()-days*864e5;
  return util_withLock_(function(){
    var sh=sheet_get_(sheet_schema_('AccountProgress')),ss=sh.getParent(),data=sh.getDataRange().getValues();
    if(data.length<2)return {archived:0};
    var head=data[0],ti=head.indexOf('timestamp'),keep=[head],old=[];
    data.slice(1).forEach(function(r){(Date.parse(r[ti])<cut?old:keep).push(r);});
    if(!old.length)return {archived:0};
    var ar=ss.getSheetByName('AccountProgressArchive')||ss.insertSheet('AccountProgressArchive');
    if(ar.getLastRow()===0)ar.appendRow(head);
    ar.getRange(ar.getLastRow()+1,1,old.length,head.length).setValues(old);
    sh.clearContents();sh.getRange(1,1,keep.length,head.length).setValues(keep);
    return {archived:old.length};
  });
}
// Plain tests (no sheets): run equity_runTests from the editor.
function equity_runTests(){
  var bad=[],now=Date.parse('2026-09-29T12:00:00Z');
  function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  t('valid row',function(){var v=equity_validateRow_({login:'12345678',balance:'10,000',equity:9400,timestamp:'2026-09-29T11:00:00Z'},now);if(!v.ok||v.row.balance!==10000)throw new Error('bad');});
  t('bad login',function(){if(equity_validateRow_({login:'12',balance:1,equity:1,timestamp:'2026-09-29T11:00:00Z'},now).ok)throw new Error('accepted');});
  t('negative equity',function(){if(equity_validateRow_({login:'12345678',balance:1,equity:-5,timestamp:'2026-09-29T11:00:00Z'},now).ok)throw new Error('accepted');});
  t('future time',function(){if(equity_validateRow_({login:'12345678',balance:1,equity:1,timestamp:'2026-09-30T11:00:00Z'},now).ok)throw new Error('accepted');});
  t('csv with header',function(){var r=equity_parseCsv_('login,balance,equity,timestamp\n12345678,10000,9400,2026-09-29T11:00:00Z');if(r.length!==1||r[0].equity!=='9400')throw new Error('bad');});
  t('csv no header',function(){if(equity_parseCsv_('12345678,10000,9400,2026-09-29T11:00:00Z').length!==1)throw new Error('bad');});
  t('secret refused when unset',function(){var ok=false;try{equity_checkSecret_({secret:'x'});}catch(e){ok=true;}if(!ok)throw new Error('accepted');});
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 17 TESTS PASSED');
}

// ===== PART 18: NOTIFICATIONS AND SCHEDULED CHECKS =====
// Earlier parts do not call notify hooks, so one scan job (every 10 minutes) reads the sheets and creates each
// notification once. The Notifications row (dedupe_key) is written BEFORE the email is sent, so a retry can never
// send twice. Only events from the last notify_scan_days (default 3) are looked at.
// Owner alerts (low stock, crypto order) go to users with the owner role.
var NOTIFY_DEFAULTS_={purchase:{s:"Your {brand} challenge is ready",b:"Hi {name},\n\nYour {plan} challenge is active. Open your dashboard to see your MT5 login and your rules.\n\n{link}\n\n{brand}"},phase_passed:{s:"{stage}: {status_label}",b:"Hi {name},\n\nGood news: your challenge moved forward ({stage}). If a new account is due, its login is waiting on your dashboard.\n\n{link}\n\n{brand}"},breach:{s:"Your challenge was breached ({rule})",b:"Hi {name},\n\nYour account {login} was closed because of this rule: {rule}.\nActual: {actual}. Allowed: {allowed}.\n{reason}\n\nYour dashboard shows the full record.\n\n{link}\n\n{brand}"},inactivity_warning:{s:"Inactivity warning: {days} days without a trade",b:"Hi {name},\n\nAccount {login} has had no trade for {days} days. It will be closed at {breach_day} days. Place a trade to stay active.\n\n{link}\n\n{brand}"},drawdown_warning:{s:"Drawdown warning: {pct}% of your limit used",b:"Hi {name},\n\nAccount {login} has used {pct}% of its maximum drawdown. Trade carefully.\n\n{link}\n\n{brand}"},payout_status:{s:"Payout {payout_id}: {status}",b:"Hi {name},\n\nYour payout request {payout_id} ({amount} USD) is now: {status}.\n\n{link}\n\n{brand}"},low_stock:{s:"Low stock: {size} USD accounts",b:"The {size} USD account pool is running low: {count} available. Import more accounts in the admin panel.\n\n{brand}"},crypto_order_pending:{s:"Crypto order awaiting confirmation: {order_ref}",b:"A crypto order ({order_ref}, {plan}) is waiting in the Crypto Orders queue.\n\n{brand}"},inactivity_held:{s:"Inactivity breach on hold: {count} account(s)",b:"{count} account(s) passed the inactivity limit but were NOT breached, because the equity data is stale or has no trade date ({logins}). Check the equity monitor or upload fresh data, then decide in Challenge Review.\n\n{brand}"},support_reply:{s:"Support replied: {subject}",b:"Hi {name},\n\nWe replied to your support request \"{subject}\":\n\n{reply}\n\n{link}\n\n{brand}"}};
var NOTIFY_TOGGLES_={"purchase": "notify_email_purchase", "phase_passed": "notify_email_phase_passed", "breach": "notify_email_breach", "inactivity_warning": "notify_email_inactivity_warning", "drawdown_warning": "notify_email_drawdown_warning", "payout_status": "notify_email_payout_status", "low_stock": "notify_email_low_stock", "crypto_order_pending": "notify_email_crypto_order_pending", "inactivity_held": "notify_email_inactivity_held", "support_reply": "notify_email_support_reply"};
var NOTIFY_OWNER_EVENTS_={low_stock:1,crypto_order_pending:1,inactivity_held:1};
// ---- Inactivity safety gate (Part 18 fix) ----
// The inactivity rule needs a trustworthy "last trade" date and fresh data. CSV uploads carry no trade date, and the
// GitHub monitor can fail, so without this gate a trader who IS trading could be warned or breached on day 23/30.
// 'held' = the rule says warn or breach, but the data cannot be trusted, so nothing happens and the owner is told.
// Settings: inactivity_feed_max_age_days (default 3), inactivity_require_trade_date (default true).
function ops_inactivityCfg_(){
  return {maxAgeDays:Number(settings_get('inactivity_feed_max_age_days',3))||3,needTradeDate:settings_get('inactivity_require_trade_date',true)!==false};
}
function ops_inactivityVerdict_(a,plan,nowD,cfg){
  var ina=rules_inactivity(plan,a.last_trade_at||a.assigned_at,nowD);
  if(ina.state!=='warning'&&ina.state!=='breach')return {state:ina.state,ina:ina};
  var upd=Date.parse(a.last_update_at),fresh=isFinite(upd)&&(nowD.getTime()-upd)<=cfg.maxAgeDays*864e5;
  if(!fresh)return {state:'held',why:'stale_feed',ina:ina};
  if(cfg.needTradeDate&&!a.last_trade_at)return {state:'held',why:'no_trade_date',ina:ina};
  return {state:ina.state,ina:ina};
}
function notify_render_(tpl,vars){return String(tpl==null?'':tpl).replace(/\{(\w+)\}/g,function(m,k){var v=vars[k];return v==null?'':String(v);});}
function notify_tpl_(event){
  var d=NOTIFY_DEFAULTS_[event];if(!d)throw new Error('Unknown notification event: '+event);
  var s=settings_get('email_'+event+'_subject',d.s),b=settings_get('email_'+event+'_body',d.b);
  return {subject:String(s||d.s),body:String(b||d.b)};
}
function notify_send_(to,subject,body){
  try{
    if(MailApp.getRemainingDailyQuota()<=0)return 'failed:quota';
    MailApp.sendEmail({to:to,subject:String(subject).replace(/[\r\n]+/g,' ').slice(0,200),body:body,name:String(settings_get('brand_name','Raven Prop')),
      replyTo:String(settings_get('support_email',''))||undefined});
    return 'sent';
  }catch(e){console.error('notify_send_: '+e);return 'failed';}
}
function notify_usd_(n){return Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2});}
// Build the list of things that should be announced. Pure reads.
function notify_collect_(now){
  var win=(Number(settings_get('notify_scan_days',3))||3)*864e5,since=now-win,out=[];
  var users={};sheet_readAll('Users').forEach(function(u){users[u.user_id]=u;});
  var plans={};sheet_readAll('ChallengePlans').forEach(function(p){plans[p.plan_id]=p;});
  var chs={};sheet_readAll('Challenges').forEach(function(c){chs[c.challenge_id]=c;});
  var recent=function(t){var x=Date.parse(t);return isFinite(x)&&x>=since;};
  var hist=function(v){var h=sheet_jsonParse_(v,[]);return Array.isArray(h)?h:[];};
  sheet_readAll('Payments').forEach(function(o){
    if(o.status==='challenge_created'&&recent(o.confirmed_at||o.updated_at))out.push({event:'purchase',user_id:o.user_id,key:'purchase:'+o.order_ref,vars:{plan:o.plan_id,order_ref:o.order_ref}});
    if(o.gateway==='manual'&&o.status==='awaiting_confirmation')out.push({event:'crypto_order_pending',owner:true,key:'crypto:'+o.order_ref,noEmail:true,vars:{plan:o.plan_id,order_ref:o.order_ref}});
  });
  Object.keys(chs).forEach(function(id){
    hist(chs[id].status_history).forEach(function(h){
      if(!recent(h.at)||!h.to)return;
      if(/\|Passed$/.test(h.to)||h.to==='Funded|Active'){
        var st=h.to.split('|');out.push({event:'phase_passed',user_id:chs[id].user_id,key:'phase:'+id+':'+h.to,vars:{stage:st[0],status_label:st[0]==='Funded'?'you are funded':'phase passed'}});
      }
    });
  });
  sheet_readAll('BreachLog').forEach(function(b){
    if(!recent(b.created_at||b.occurred_at))return;
    out.push({event:'breach',user_id:b.user_id,key:'breach:'+b.breach_id,vars:{rule:String(b.rule||'').replace(/_/g,' '),login:b.login,actual:b.actual_value,allowed:b.allowed_value,reason:b.admin_note||''}});
  });
  sheet_readAll('Payouts').forEach(function(p){
    hist(p.status_history).forEach(function(h){
      if(recent(h.at)&&h.to)out.push({event:'payout_status',user_id:p.user_id,key:'payout:'+p.payout_id+':'+h.to,vars:{payout_id:p.payout_id,status:h.to,amount:notify_usd_(p.amount_usd)}});
    });
  });
  sheet_readAll('SupportTickets').forEach(function(t){
    if(t.admin_reply&&t.replied_at&&recent(t.replied_at))out.push({event:'support_reply',user_id:t.user_id,key:'ticket:'+t.ticket_id+':'+t.replied_at,vars:{subject:t.subject,reply:t.admin_reply}});
  });
  var warnPct=Number(settings_get('drawdown_warning_pct',80))||80,nowD=new Date(now),icfg=ops_inactivityCfg_(),held=[];
  sheet_findRows('Accounts',{status:'Active'}).forEach(function(a){
    var ch=chs[a.challenge_id],plan=ch&&plans[ch.plan_id];if(!plan||ch.status!=='Active')return;
    try{
      var v=ops_inactivityVerdict_(a,plan,nowD,icfg),ina=v.ina;
      if(v.state==='warning')out.push({event:'inactivity_warning',user_id:a.user_id,key:'inact:'+a.account_id,vars:{login:a.login,days:ina.days_inactive,breach_day:ina.breach_day}});
      if(v.state==='held')held.push(a.login);
      if(a.last_equity!==''&&a.last_equity!=null){
        var d=rules_maxLoss(plan,a.stage,a.start_balance,a.last_equity);
        if(!d.breached&&d.used_pct>=warnPct)out.push({event:'drawdown_warning',user_id:a.user_id,key:'dd:'+a.account_id,vars:{login:a.login,pct:Math.floor(d.used_pct)}});
      }
    }catch(e){console.error('notify_collect_ '+a.account_id+': '+e);}
  });
  var day=new Date(now).toISOString().slice(0,10);
  // Warning repeat rules (on purpose): drawdown and inactivity warnings fire once per account (an account is one stage),
  // held-inactivity and low-stock alerts repeat once a day until fixed.
  if(held.length)out.push({event:'inactivity_held',owner:true,key:'inactheld:'+day,vars:{count:held.length,logins:held.slice(0,10).join(', ')+(held.length>10?' ...':'')}});
  pool_lowStock().forEach(function(s){out.push({event:'low_stock',owner:true,key:'lowstock:'+s.size+':'+day,vars:{size:s.size,count:s.available}});});
  return {items:out,users:users};
}
function notify_scan(){
  return util_withLock_(function(){
    var now=Date.now(),col=notify_collect_(now),users=col.users,have={},ids={},retry=[];
    var winMs=(Number(settings_get('notify_scan_days',3))||3)*864e5;
    sheet_readAll('Notifications').forEach(function(n){
      have[n.dedupe_key]=1;ids[n.notification_id]=1;
      // A mail that failed only because the daily quota ran out is tried again on a later scan (never twice once sent).
      if(n.email_status==='failed:quota'&&now-Date.parse(n.created_at)<=winMs)retry.push(n);
    });
    var owners=Object.keys(users).map(function(k){return users[k];}).filter(function(u){return u.role==='owner'&&u.status==='active';});
    var brand=settings_get('brand_name','Raven Prop'),site=String(settings_get('site_url','')||'');
    var rows=[],mails=[],nowIso=util_nowIso_();
    col.items.forEach(function(it){
      var targets=it.owner?owners:[users[it.user_id]].filter(Boolean);
      targets.forEach(function(u){
        var key=it.key+'|'+u.user_id;if(have[key])return;have[key]=1;
        var vars=Object.assign({name:u.full_name||'trader',brand:brand,link:site},it.vars),t=notify_tpl_(it.event);
        var title=notify_render_(t.subject,vars),msg=notify_render_(t.body,vars);
        var on=!it.noEmail&&settings_get(NOTIFY_TOGGLES_[it.event],true)!==false&&!!u.email;
        var id=util_newId_('N',function(x){return ids[x];});ids[id]=1;
        rows.push({notification_id:id,user_id:u.user_id,event:it.event,title:title,message:msg,dedupe_key:key,is_read:false,email_status:on?'queued':(it.noEmail?'not_needed':'off'),created_at:nowIso});
        if(on)mails.push({key:key,to:u.email,subject:title,body:msg});
      });
    });
    if(rows.length)sheet_appendRows('Notifications',rows);   // record first: this is what makes sending exactly-once
    var status={};mails.forEach(function(m){status[m.key]=notify_send_(m.to,m.subject,m.body);});
    var retried=0;
    retry.forEach(function(n){
      var u=users[n.user_id];if(!u||!u.email)return;
      var r=notify_send_(u.email,n.title,n.message);if(r==='failed:quota')return;   // still no quota: leave it for tomorrow
      status[n.dedupe_key]=r;retried++;
    });
    var upd=[];
    if(Object.keys(status).length)sheet_readAll('Notifications').forEach(function(n){
      if(status[n.dedupe_key]&&(n.email_status==='queued'||n.email_status==='failed:quota'))upd.push({target:n,changes:{email_status:status[n.dedupe_key]}});
    });
    if(upd.length)sheet_updateRows('Notifications',upd);
    return {created:rows.length,emails:mails.length,retried:retried};
  });
}
// ---- Trader endpoints: notifications and support tickets ----
function notify_list(p,ctx){
  p=p||{};
  var rows=sheet_findRows('Notifications',{user_id:ctx.user.user_id}).sort(function(a,b){return String(b.created_at).localeCompare(String(a.created_at));});
  var unread=rows.filter(function(n){return !n.is_read;}).length;
  if(p.unread_only)rows=rows.filter(function(n){return !n.is_read;});
  return {unread:unread,notifications:rows.slice(0,Math.min(Math.max(Number(p.limit)||50,1),100)).map(function(n){
    return {notification_id:n.notification_id,event:n.event,title:n.title,message:n.message,is_read:!!n.is_read,created_at:n.created_at};})};
}
function notify_markRead(p,ctx){
  p=p||{};var want={};
  if(Array.isArray(p.ids))p.ids.slice(0,100).forEach(function(i){want[String(i)]=1;});
  else if(p.all!==true)throw util_error_(CODES.BAD_REQUEST,'Send ids or all:true.');
  var now=util_nowIso_(),upd=[];
  sheet_findRows('Notifications',{user_id:ctx.user.user_id}).forEach(function(n){if(!n.is_read&&(p.all===true||want[n.notification_id]))upd.push({target:n,changes:{is_read:true,read_at:now}});});
  if(upd.length)sheet_updateRows('Notifications',upd);
  return {marked:upd.length};
}
function support_create(p,ctx){
  p=p||{};var subject=String(p.subject==null?'':p.subject).trim(),message=String(p.message==null?'':p.message).trim();
  if(subject.length<3||subject.length>100)throw util_error_(CODES.BAD_REQUEST,'Subject must be 3 to 100 characters.');
  if(message.length<5||message.length>2000)throw util_error_(CODES.BAD_REQUEST,'Message must be 5 to 2000 characters.');
  return util_withLock_(function(){
    if(sheet_findRows('SupportTickets',{user_id:ctx.user.user_id,status:'open'}).length>=5)throw util_error_(CODES.BAD_REQUEST,'You already have 5 open tickets. Please wait for a reply.');
    var now=util_nowIso_(),row={user_id:ctx.user.user_id,subject:subject,message:message,status:'open',created_at:now,updated_at:now};
    return {ticket:sheet_appendRow('SupportTickets',row)};
  });
}
function support_listMine(p,ctx){
  return {tickets:sheet_findRows('SupportTickets',{user_id:ctx.user.user_id}).sort(function(a,b){return String(b.created_at).localeCompare(String(a.created_at));}).slice(0,50).map(function(t){
    return {ticket_id:t.ticket_id,subject:t.subject,message:t.message,status:t.status,admin_reply:t.admin_reply,created_at:t.created_at,replied_at:t.replied_at};})};
}
// ---- Scheduled jobs. Install once with ops_installTriggers (run it from the Apps Script editor). ----
// Daily: any Active account with no trade for the breach day count is breached (a trader who stops sending data cannot dodge it).
function ops_inactivityBreach_(){
  var plans={},chs={},n=0,heldN=0,now=new Date(),cfg=ops_inactivityCfg_();
  sheet_readAll('ChallengePlans').forEach(function(p){plans[p.plan_id]=p;});
  sheet_readAll('Challenges').forEach(function(c){chs[c.challenge_id]=c;});
  sheet_findRows('Accounts',{status:'Active'}).forEach(function(a){
    var ch=chs[a.challenge_id],plan=ch&&plans[ch.plan_id];if(!plan||ch.status!=='Active')return;
    try{
      var v=ops_inactivityVerdict_(a,plan,now,cfg);
      if(v.state==='held')heldN++;   // announced to the owner by notify_scan (inactivity_held)
      if(v.state==='breach'){chal_breachStage(ch.challenge_id,{rule:'inactivity',actual_value:v.ina.days_inactive,allowed_value:v.ina.breach_day,evidence:'daily inactivity check'},{by:'system:inactivity'});n++;}
    }catch(e){console.error('ops_inactivityBreach_ '+a.account_id+': '+e);}
  });
  return {breached:n,held:heldN};
}
function ops_step_(name,fn){try{return fn();}catch(e){console.error(name+' failed: '+e);return 'error: '+e.message;}}
// Calls a function by name if it exists. A missing function (for example a part not installed yet) is reported, not fatal.
function ops_call_(name){
  return ops_step_(name,function(){return typeof globalThis[name]==='function'?globalThis[name]():'skipped: '+name+' is not installed';});
}
function ops_every10(){
  return {reconcile:ops_call_('gw_reconcilePending'),expire:ops_call_('pay_expireStale'),notify:ops_call_('notify_scan')};
}
function ops_daily(){
  return {inactivity:ops_call_('ops_inactivityBreach_'),affiliates:ops_call_('aff_maintenance'),archive:ops_call_('equity_archive'),notify:ops_call_('notify_scan')};
}
function ops_installTriggers(){
  var mine={ops_every10:1,ops_daily:1};
  ScriptApp.getProjectTriggers().forEach(function(t){if(mine[t.getHandlerFunction()])ScriptApp.deleteTrigger(t);});
  ScriptApp.newTrigger('ops_every10').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('ops_daily').timeBased().everyDays(1).atHour(1).create();
  return ScriptApp.getProjectTriggers().map(function(t){return t.getHandlerFunction();});
}
// Deliverability check for support@ravenprop.cfd: edit nothing, just run this from the editor. It mails OWNER_EMAIL
// (Script Property) or, if that is empty, the support_email setting. Ask a Gmail address to be the owner email to test Gmail.
function ops_sendTestEmail(){
  var to=PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL')||String(settings_get('support_email','')||'');
  if(!to)throw new Error('Set the OWNER_EMAIL Script Property first.');
  var r=notify_send_(to,'Raven Prop test email','If you can read this in your inbox (not spam), email delivery works. Sent '+util_nowIso_()+'.');
  console.log('Test email to '+to+': '+r);return r;
}
// Run after updating the code so the new email-template settings are added to the Settings sheet (existing values are kept).
function ops_topUpSettings(){return sheet_buildAll_();}
function notify_runTests(){
  var bad=[];function t(n,f){try{f();}catch(e){bad.push(n+': '+e.message);}}
  function eq(a,b,m){if(a!==b)throw new Error((m||'')+' expected '+b+' got '+a);}
  t('render fills and blanks',function(){eq(notify_render_('Hi {name}{x}!',{name:'Ada'}),'Hi Ada!');});
  t('every event has a default and a toggle',function(){Object.keys(NOTIFY_DEFAULTS_).forEach(function(k){if(!NOTIFY_TOGGLES_[k]||!NOTIFY_DEFAULTS_[k].s||!NOTIFY_DEFAULTS_[k].b)throw new Error(k);});});
  t('ten events',function(){eq(Object.keys(NOTIFY_DEFAULTS_).length,10,'count');});
  t('owner events are owner only',function(){if(!NOTIFY_OWNER_EVENTS_.low_stock||!NOTIFY_OWNER_EVENTS_.inactivity_held||NOTIFY_OWNER_EVENTS_.breach||NOTIFY_OWNER_EVENTS_.support_reply)throw new Error('bad');});
  // Inactivity gate (the day-23 / day-30 rule with the safety checks). Uses the seeded Swift $10k plan: warning day 23, breach day 30.
  var plan=sheet_seedPlans_().filter(function(p){return p.plan_id==='swift-10000';})[0],now=new Date('2026-06-30T12:00:00Z'),DAY=864e5;
  function ago(d){return new Date(now.getTime()-d*DAY).toISOString();}
  function acct(tradeDays,updDays){return {assigned_at:ago(40),last_trade_at:tradeDays==null?'':ago(tradeDays),last_update_at:updDays==null?'':ago(updDays)};}
  var cfg={maxAgeDays:3,needTradeDate:true};
  t('day 5 is fine',function(){eq(ops_inactivityVerdict_(acct(5,0.1),plan,now,cfg).state,'ok');});
  t('day 23 with fresh data warns',function(){eq(ops_inactivityVerdict_(acct(23.5,0.1),plan,now,cfg).state,'warning');});
  t('day 31 with fresh data breaches',function(){eq(ops_inactivityVerdict_(acct(31,0.1),plan,now,cfg).state,'breach');});
  t('stale feed holds the breach',function(){var v=ops_inactivityVerdict_(acct(31,10),plan,now,cfg);eq(v.state,'held');eq(v.why,'stale_feed');});
  t('never-updated account is held',function(){eq(ops_inactivityVerdict_(acct(31,null),plan,now,cfg).state,'held');});
  t('no trade date holds (CSV-only data)',function(){var v=ops_inactivityVerdict_(acct(null,0.1),plan,now,cfg);eq(v.state,'held');eq(v.why,'no_trade_date');});
  t('trade date not required when switched off',function(){eq(ops_inactivityVerdict_(acct(null,0.1),plan,now,{maxAgeDays:3,needTradeDate:false}).state,'breach');});
  if(bad.length)throw new Error('Failed: '+bad.join(' | '));
  console.log('ALL PART 18 TESTS PASSED');
}
