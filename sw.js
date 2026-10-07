/* Raven Prop service worker: faster repeat visits, safe updates.
   - Images/icons/fonts: cache first (they rarely change).
   - HTML/CSS/JS: network first with a short timeout, saved copy if the network is slow or offline.
   - Never touches the API (script.google.com) or any other site, and never stores tokens or user data. */
var V="rv-v3",STATIC=V+"-static",PAGES=V+"-pages";
var SHELL=["./","index.html","app.html","app.css","app-ui.css","config.js","app.js","ux.js","dashboard.html","login.html","logo.svg","favicon.svg","icon-192.png"];
self.addEventListener("install",function(e){
  e.waitUntil(caches.open(PAGES).then(function(c){return Promise.all(SHELL.map(function(u){return c.add(u).catch(function(){})}))}).then(function(){return self.skipWaiting()}));
});
self.addEventListener("activate",function(e){
  e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(n){return n.indexOf(V)!==0}).map(function(n){return caches.delete(n)}))}).then(function(){return self.clients.claim()}));
});
function netFirst(req,ms){
  return caches.open(PAGES).then(function(cache){
    return new Promise(function(res){
      var done=false,t=setTimeout(function(){cache.match(req).then(function(m){if(m&&!done){done=true;res(m)}})},ms);
      fetch(req).then(function(r){clearTimeout(t);if(r&&r.ok)cache.put(req,r.clone());if(!done){done=true;res(r)}})
       .catch(function(){clearTimeout(t);cache.match(req).then(function(m){if(!done){done=true;res(m||Response.error())}})});
    });
  });
}
function cacheFirst(req){
  return caches.open(STATIC).then(function(cache){
    return cache.match(req).then(function(m){
      return m||fetch(req).then(function(r){if(r&&r.ok)cache.put(req,r.clone());return r});
    });
  });
}
self.addEventListener("fetch",function(e){
  var r=e.request,u=new URL(r.url);
  if(r.method!=="GET"||u.origin!==location.origin)return;
  if(/\.(png|jpe?g|svg|ico|webp|woff2?)$/i.test(u.pathname)){e.respondWith(cacheFirst(r));return}
  if(r.mode==="navigate"||/\.(html|css|js)$/i.test(u.pathname)||u.pathname==="/"){e.respondWith(netFirst(r,2500))}
});
