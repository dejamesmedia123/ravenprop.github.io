(function(){var d=document,r=d.documentElement;
var b=d.getElementById("tt");b&&b.addEventListener("click",function(){var k=r.getAttribute("data-theme")==="dark"?"light":"dark";r.setAttribute("data-theme",k);try{localStorage.setItem("raven_theme",k);localStorage.removeItem("raven_dark_until")}catch(e){}var m=d.querySelector('meta[name="theme-color"]');m&&m.setAttribute("content",k==="dark"?"#050505":"#FFF8F1")});
var t=d.getElementById("toc");if(t&&matchMedia("(max-width:899px)").matches)t.removeAttribute("open");
var p=d.getElementById("bar");if(p){var u=function(){var h=r.scrollHeight-innerHeight;p.style.transform="scaleX("+(h>0?Math.min(1,scrollY/h):0)+")"};addEventListener("scroll",u,{passive:true});u()}
if(t&&"IntersectionObserver"in window){var L=[].slice.call(t.querySelectorAll("a")),o=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){L.forEach(function(a){a.classList.toggle("on",a.getAttribute("href")==="#"+e.target.id)})}})},{rootMargin:"-80px 0px -65% 0px"});[].forEach.call(d.querySelectorAll(".prose h2[id]"),function(h){o.observe(h)})}
})();
