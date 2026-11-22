(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const KEY_STORE = "vc_key";

  // Natural-dye colours from Guatemalan weaving: indigo ink, Maya blue
  // water, jade forests, cochineal red.
  const COLORS = {
    paper: "#f4ecd9",
    ink: "#2b2d6e",
    inkSoft: "#5a5f8f",
    water: "#93d0d9",
    waterLine: "#2e9cb5",
    waterText: "#1f6f83",
    wood: "#9fcd98",
    park: "#b9d892",
    town: "#f1d3bd",
    adobe: "#e3b892",
    cochineal: "#b0233a",
    boat: "#1c3f8f",
  };
  // Antigua's painted walls: saffron, coral, sky blue, pistachio,
  // bougainvillea, ochre, terracotta, whitewash and turquoise.
  const FACADES = ["#e8a33d", "#d9644a", "#6fa8c9", "#a8c66c", "#c2357a", "#d4a24c", "#c8643b", "#efe3c8", "#4fb3b0"];
  // Mapterhorn: free, open elevation tiles. The older AWS tiles had corrupt
  // pixels that drew a 5 km needle out of Lake Atitlán.
  const TERRAIN_TILES = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

  let story, key, map, lock;
  let chapters = [];
  let index = 0;
  let navToken = 0;
  let legs = [];
  let stopMarkers = [];
  let placeMarkers = [];
  // The lake's village dots stay hidden until asked for, so the map first
  // shows only the places Shaun went.
  let townMarkers = [];
  let villageStoryShown = false;
  let modalReturnFocus = null;
  let modalPhotos = [];
  const photoUrls = new Map();

  // ---------- Unlocking ----------

  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  async function fetchBytes(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function decrypt(bytes) {
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  }

  async function deriveKey(password) {
    const base = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: fromB64(lock.salt), iterations: lock.iterations, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }

  async function openStory(candidate) {
    key = candidate;
    const plain = await decrypt(await fetchBytes("data/story.bin"));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function savedKey() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY_STORE) || "null");
      return saved && saved.salt === lock.salt ? saved.key : null;
    } catch (e) {
      return null;
    }
  }

  async function rememberKey() {
    try {
      const raw = await crypto.subtle.exportKey("raw", key);
      localStorage.setItem(KEY_STORE, JSON.stringify({ salt: lock.salt, key: toB64(raw) }));
    } catch (e) { /* private mode: they'll just type it again next time */ }
  }

  async function init() {
    lock = await (await fetch("data/lock.json", { cache: "no-cache" })).json();
    const saved = savedKey();
    if (saved) {
      try {
        const k = await crypto.subtle.importKey("raw", fromB64(saved), "AES-GCM", true, ["decrypt"]);
        start(await openStory(k));
        return;
      } catch (e) {
        try { localStorage.removeItem(KEY_STORE); } catch (e2) { /* ignore */ }
      }
    }
    $("#password").focus();
  }

  $("#lock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#unlock");
    const error = $("#lock-error");
    button.disabled = true;
    button.textContent = "Opening…";
    error.textContent = "";
    try {
      const data = await openStory(await deriveKey($("#password").value));
      await rememberKey();
      start(data);
    } catch (e) {
      error.textContent = "That password didn't work. Please try again.";
      button.disabled = false;
      button.textContent = "Open the story";
      $("#password").select();
    }
  });

  // ---------- Starting the story ----------

  function start(data) {
    story = data;
    const stops = story.stops;
    chapters = [{ type: "intro", id: "start", stop: stops[0], stopIndex: 0 }];
    stops.slice(1).forEach((stop, i) => chapters.push({ type: "stop", id: stop.id, stop, stopIndex: i + 1 }));
    chapters.push({ type: "outro", id: "end", stopIndex: stops.length - 1 });
    legs = stops.slice(1).map((stop, i) => {
      if (stop.arrive === "flight") {
        const coords = greatCircle(stops[i].coords, stop.coords, 96);
        return { coords, parts: [{ mode: "flight", coords }] };
      }
      // A "route" splits the journey into road and boat parts. Without one,
      // "via" points bend a single road trip through the towns it passed.
      const route = stop.route || [{ mode: stop.arrive, via: stop.via || [] }];
      let start = stops[i].coords;
      const parts = route.map((part, k) => {
        const points = [start, ...part.via];
        if (k === route.length - 1) points.push(stop.coords);
        start = points[points.length - 1];
        return { mode: part.mode, coords: densify(points) };
      });
      return { coords: parts.flatMap((part) => part.coords), parts };
    });

    const fromHash = chapters.findIndex((c) => "#" + c.id === location.hash);
    index = fromHash > 0 ? fromHash : 0;

    $("#lock").classList.add("leaving");
    setTimeout(() => $("#lock").remove(), 900);
    buildMap();
  }

  function buildMap() {
    map = new maplibregl.Map({
      container: "map",
      style: mapStyle(),
      center: [-84, 25],
      zoom: 2.4,
      maxPitch: 78,
      keyboard: false,
      attributionControl: false,
      fadeDuration: 200,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    // "style.load" fires before the tiles arrive, so the story can start
    // while the map is still filling in. "load" would wait for every tile.
    map.once("style.load", () => {
      addFacadePattern();
      addRouteLayers();
      addTrails();
      addStopMarkers();
      $("#nav").hidden = false;
      go(index, true);
    });
    // On phones the map credits start folded behind their (i) button.
    // MapLibre opens them while loading, so fold them once it's done.
    map.once("idle", () => {
      if (isPhone()) document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    });
    map.on("zoom", updateStopLabels);
    // Any touch, drag or scroll on the map stops the slow turn.
    ["mousedown", "touchstart", "wheel"].forEach((type) => map.on(type, stopOrbit));
    window.addEventListener("resize", () => updateStopLabels());
  }

  // ---------- Map style: woven colours on paper ----------

  function mapStyle() {
    const name = ["coalesce", ["get", "name:en"], ["get", "name"]];
    return {
      version: 8,
      // A globe for the journey overview, flat for the cities. MapLibre's own
      // "globe" blends into the flat map between zoom 11 and 12, and during
      // that blend 3D terrain and pins disagree, so pins float above the
      // hills. Finishing the blend by zoom 7 keeps every city view flat.
      projection: { type: ["interpolate", ["linear"], ["zoom"], 5, "vertical-perspective", 7, "mercator"] },
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        omt: {
          type: "vector",
          url: "https://tiles.openfreemap.org/planet",
          attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
        },
        terrain: {
          type: "raster-dem", tiles: [TERRAIN_TILES], tileSize: 512, maxzoom: 12, encoding: "terrarium",
          attribution: '<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>',
        },
        shade: { type: "raster-dem", tiles: [TERRAIN_TILES], tileSize: 512, maxzoom: 12, encoding: "terrarium" },
      },
      terrain: { source: "terrain", exaggeration: 1.35 },
      sky: {
        "sky-color": "#cfe8ec",
        "horizon-color": COLORS.paper,
        "fog-color": COLORS.paper,
        "sky-horizon-blend": 0.7,
        "horizon-fog-blend": 0.6,
        "fog-ground-blend": 0.35,
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 5, 0.2, 7, 0],
      },
      layers: [
        { id: "background", type: "background", paint: { "background-color": COLORS.paper } },
        {
          id: "wood", type: "fill", source: "omt", "source-layer": "landcover",
          filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]],
          paint: { "fill-color": COLORS.wood, "fill-opacity": 0.5 },
        },
        {
          id: "park", type: "fill", source: "omt", "source-layer": "park",
          paint: { "fill-color": COLORS.park, "fill-opacity": 0.5 },
        },
        {
          id: "town", type: "fill", source: "omt", "source-layer": "landuse",
          filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood"]]],
          paint: { "fill-color": COLORS.town, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0, 12, 0.7] },
        },
        {
          id: "hillshade", type: "hillshade", source: "shade",
          paint: {
            "hillshade-shadow-color": "#3a3d72",
            "hillshade-highlight-color": "#fffaf0",
            "hillshade-accent-color": "#7b4a6e",
            "hillshade-exaggeration": 0.5,
          },
        },
        {
          id: "water", type: "fill", source: "omt", "source-layer": "water",
          paint: { "fill-color": COLORS.water },
        },
        {
          id: "water-edge", type: "line", source: "omt", "source-layer": "water",
          paint: {
            "line-color": COLORS.waterLine,
            "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 12, 1.2],
            "line-opacity": 0.8,
          },
        },
        {
          id: "rivers", type: "line", source: "omt", "source-layer": "waterway", minzoom: 8,
          paint: { "line-color": COLORS.waterLine, "line-width": 0.8, "line-opacity": 0.6 },
        },
        {
          id: "borders", type: "line", source: "omt", "source-layer": "boundary",
          filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
          paint: {
            "line-color": COLORS.ink, "line-opacity": 0.45, "line-dasharray": [3, 2],
            "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 8, 1.4],
          },
        },
        {
          id: "roads-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 12,
          filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track"]]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLORS.inkSoft, "line-opacity": 0.4,
            "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 0.4, 16, 2.4, 18, 6],
          },
        },
        {
          id: "paths", type: "line", source: "omt", "source-layer": "transportation", minzoom: 13,
          filter: ["in", ["get", "class"], ["literal", ["path"]]],
          paint: { "line-color": COLORS.inkSoft, "line-opacity": 0.5, "line-width": 0.8, "line-dasharray": [2, 2] },
        },
        {
          id: "roads-major", type: "line", source: "omt", "source-layer": "transportation", minzoom: 5,
          filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary"]]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLORS.ink, "line-opacity": 0.42,
            "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 5, 0.4, 10, 1, 14, 2.6, 18, 9],
          },
        },
        {
          id: "buildings", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 13,
          paint: {
            "fill-extrusion-color": COLORS.adobe,
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 5],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 0.9],
          },
        },
        {
          id: "water-names", type: "symbol", source: "omt", "source-layer": "water_name",
          layout: {
            "text-field": ["case", ["==", ["get", "class"], "lake"], ["get", "name"], name],
            "text-font": ["Noto Sans Italic"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11, 10, 14],
            "text-letter-spacing": 0.18,
            "text-max-width": 8,
          },
          paint: { "text-color": COLORS.waterText, "text-halo-color": COLORS.paper, "text-halo-width": 1 },
        },
        {
          id: "countries", type: "symbol", source: "omt", "source-layer": "place", maxzoom: 7.5,
          filter: ["==", ["get", "class"], "country"],
          layout: {
            "text-field": name,
            "text-font": ["Noto Sans Regular"],
            "text-transform": "uppercase",
            "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 6, 14],
            "text-letter-spacing": 0.35,
            "text-max-width": 7,
          },
          paint: { "text-color": COLORS.inkSoft, "text-halo-color": COLORS.paper, "text-halo-width": 1.2 },
        },
        {
          id: "villages", type: "symbol", source: "omt", "source-layer": "place", minzoom: 10, maxzoom: 13.5,
          filter: ["in", ["get", "class"], ["literal", ["town", "village"]]],
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Noto Sans Italic"],
            "text-size": 12,
            "text-max-width": 8,
          },
          paint: { "text-color": COLORS.inkSoft, "text-halo-color": COLORS.paper, "text-halo-width": 1.4 },
        },
        {
          id: "peaks", type: "symbol", source: "omt", "source-layer": "mountain_peak", minzoom: 9,
          // Acatenango's own summit labels are left out: its trail pin names it.
          filter: ["all", ["has", "name"], [">=", ["coalesce", ["get", "ele"], 0], 3000],
            ["!", ["in", ["get", "name"], ["literal", ["Acatenango", "Cumbre el Plato", "Cumbre de Yepocapa"]]]]],
          layout: {
            "text-field": ["format", ["get", "name"], {}, "\n", {}, ["concat", ["to-string", ["get", "ele"]], " m"], { "font-scale": 0.85 }],
            "text-font": ["Noto Sans Italic"],
            "text-size": 12,
            "text-max-width": 9,
          },
          paint: { "text-color": COLORS.ink, "text-halo-color": COLORS.paper, "text-halo-width": 1.5 },
        },
      ],
    };
  }

  // ---------- Route lines ----------

  function straight(a, b, n) {
    const out = [];
    for (let i = 0; i <= n; i++) out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
    return out;
  }

  // Adds in-between points to long straight stretches, so the line drawn
  // during a flight-over grows smoothly. Routes from a router are already dense.
  function densify(points) {
    if (points.length > 20) return points;
    const out = [points[0]];
    for (let k = 1; k < points.length; k++) out.push(...straight(points[k - 1], points[k], 24).slice(1));
    return out;
  }

  function greatCircle(a, b, n) {
    const rad = Math.PI / 180;
    const toVec = ([lng, lat]) => [Math.cos(lat * rad) * Math.cos(lng * rad), Math.cos(lat * rad) * Math.sin(lng * rad), Math.sin(lat * rad)];
    const p = toVec(a), q = toVec(b);
    const omega = Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const s1 = Math.sin((1 - t) * omega) / Math.sin(omega);
      const s2 = Math.sin(t * omega) / Math.sin(omega);
      const v = [0, 1, 2].map((k) => s1 * p[k] + s2 * q[k]);
      out.push([Math.atan2(v[1], v[0]) / rad, Math.atan2(v[2], Math.hypot(v[0], v[1])) / rad]);
    }
    return out;
  }

  function routeData(doneThrough) {
    return {
      type: "FeatureCollection",
      features: legs.flatMap((leg, i) => leg.parts.map((part) => ({
        type: "Feature",
        properties: { mode: part.mode, done: i + 1 <= doneThrough },
        geometry: { type: "LineString", coordinates: part.coords },
      }))),
    };
  }

  function addRouteLayers() {
    map.addSource("route", { type: "geojson", data: routeData(0) });
    map.addSource("route-active", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const opacity = ["case", ["get", "done"], 0.9, 0.45];
    map.addLayer({
      id: "route-flight", type: "line", source: "route",
      filter: ["==", ["get", "mode"], "flight"],
      paint: { "line-color": COLORS.ink, "line-width": 1.8, "line-dasharray": [3, 2.5], "line-opacity": opacity },
    });
    map.addLayer({
      id: "route-ground", type: "line", source: "route",
      filter: ["!", ["in", ["get", "mode"], ["literal", ["flight", "boat"]]]],
      layout: { "line-cap": "round" },
      // Up close the dotted road would cover the streets, so it fades.
      paint: {
        "line-color": COLORS.cochineal, "line-width": 3.2, "line-dasharray": [0.1, 2],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, opacity, 15, ["case", ["get", "done"], 0.35, 0.2]],
      },
    });
    map.addLayer({
      id: "route-boat", type: "line", source: "route",
      filter: ["==", ["get", "mode"], "boat"],
      layout: { "line-cap": "round" },
      paint: { "line-color": COLORS.boat, "line-width": 3, "line-dasharray": [1.6, 1.4], "line-opacity": opacity },
    });
    map.addLayer({
      id: "route-active", type: "line", source: "route-active",
      layout: { "line-cap": "round" },
      paint: { "line-color": COLORS.cochineal, "line-width": 2.6 },
    });
  }

  // Hiking trails (Acatenango) drawn on the hills in the stop's colour,
  // with a pale edge so they stand out on the shading.
  function addTrails() {
    story.stops.filter((stop) => stop.trail).forEach((stop) => {
      const id = `trail-${stop.id}`;
      map.addSource(id, {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: stop.trail.coords } },
      });
      const layout = { "line-cap": "round", "line-join": "round" };
      map.addLayer({
        id: `${id}-edge`, type: "line", source: id, minzoom: 10, layout,
        paint: { "line-color": "#fffaf0", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 7], "line-opacity": 0.85 },
      });
      map.addLayer({
        id, type: "line", source: id, minzoom: 10, layout,
        paint: { "line-color": stop.color || COLORS.cochineal, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 3.5] },
      });
    });
    // Short trips inside a chapter, like the ferry from Santa Cruz to San Marcos.
    story.stops.filter((stop) => stop.trips).forEach((stop) => {
      stop.trips.forEach((trip, n) => {
        const id = `trip-${stop.id}-${n}`;
        map.addSource(id, {
          type: "geojson",
          data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: densify(trip.coords) } },
        });
        map.addLayer({
          id, type: "line", source: id, minzoom: 9, layout: { "line-cap": "round" },
          paint: { "line-color": trip.mode === "boat" ? COLORS.boat : COLORS.cochineal, "line-width": 3, "line-dasharray": [1.6, 1.4] },
        });
      });
    });
  }

  function setRoute(doneThrough) {
    map.getSource("route").setData(routeData(doneThrough));
  }

  // Draws the leg into a stop while the camera flies there.
  function animateLeg(legIndex, duration, token) {
    const coords = legs[legIndex].coords;
    const dot = document.createElement("div");
    dot.className = "traveller";
    const traveller = new maplibregl.Marker({ element: dot }).setLngLat(coords[0]).addTo(map);
    const source = map.getSource("route-active");
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    // Real roads have many points on their bends and few on the straights,
    // so the line advances by distance, not by point, to keep an even pace.
    const along = [0];
    for (let k = 1; k < coords.length; k++) {
      const [x1, y1] = coords[k - 1], [x2, y2] = coords[k];
      along.push(along[k - 1] + Math.hypot((x2 - x1) * Math.cos(y1 * Math.PI / 180), y2 - y1));
    }
    const total = along[along.length - 1] || 1;
    let n = 1;

    function frame(now) {
      if (token !== navToken) { traveller.remove(); return; }
      const t = Math.min(1, (now - t0) / duration);
      const d = ease(t) * total;
      while (n < coords.length - 1 && along[n] < d) n++;
      const f = Math.min(1, Math.max(0, (d - along[n - 1]) / ((along[n] - along[n - 1]) || 1)));
      const [a, b] = [coords[n - 1], coords[n]];
      const part = [...coords.slice(0, n), [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]];
      source.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: part } });
      traveller.setLngLat(part[part.length - 1]);
      if (t < 1) requestAnimationFrame(frame);
      else traveller.remove();
    }
    requestAnimationFrame(frame);
  }

  function clearActiveLeg() {
    map.getSource("route-active").setData({ type: "FeatureCollection", features: [] });
  }

  // ---------- Stop markers ----------

  function addStopMarkers() {
    stopMarkers = story.stops.map((stop, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "stop-marker";
      el.innerHTML = `<span class="dot"></span><span class="name"></span>`;
      el.querySelector(".name").textContent = stop.name;
      el.setAttribute("aria-label", `Go to ${stop.name}`);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        go(chapters.findIndex((c) => c.stopIndex === i && c.type !== "outro"));
      });
      const marker = new maplibregl.Marker({ element: el, anchor: "left", offset: [-7, 0] })
        .setLngLat(stop.coords).addTo(map);
      return { el, marker, stop };
    });
    updateStopLabels();
  }

  // When zoomed out, the Guatemalan stops sit on top of each other,
  // so only their dots show until the map is close enough to separate them.
  function updateStopLabels() {
    if (!map) return;
    const zoom = map.getZoom();
    stopMarkers.forEach(({ el, stop }) => {
      el.classList.toggle("small", stop.country === "Guatemala" && zoom < 7.5);
    });
  }

  // In a city, the current stop's name is on the card and far-off stops
  // would float on the horizon, so both are hidden.
  function markStops() {
    const chapter = chapters[index];
    const here = chapter.type === "stop" ? maplibregl.LngLat.convert(chapter.stop.coords) : null;
    stopMarkers.forEach(({ el, stop }, i) => {
      const far = here && here.distanceTo(maplibregl.LngLat.convert(stop.coords)) > 40000;
      el.classList.toggle("visited", i <= chapter.stopIndex);
      el.classList.toggle("here", Boolean(here) && (i === chapter.stopIndex || far));
    });
  }

  // ---------- Camera ----------

  function isPhone() {
    return window.innerWidth <= 760;
  }

  function padding() {
    // On phones the card (44% of the height) and the arrows cover the bottom.
    if (isPhone()) return { top: 40, bottom: Math.round(window.innerHeight * 0.44 + 110), left: 20, right: 20 };
    return { top: 40, bottom: 110, left: window.innerWidth <= 1050 ? 380 : 440, right: 40 };
  }

  // Fits every stop into the space the card and arrows leave free.
  // MapLibre's own fitting misplaces things on the globe, so this uses
  // flat-map maths, which runs slightly loose on a globe (the safe side).
  function overviewCamera() {
    const pad = padding();
    const lngs = story.stops.map((s) => s.coords[0]);
    const lats = story.stops.map((s) => s.coords[1]);
    const mercY = (lat) => 0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI);
    const north = mercY(Math.max(...lats));
    const south = mercY(Math.min(...lats));
    const width = window.innerWidth - pad.left - pad.right - 120;
    const height = window.innerHeight - pad.top - pad.bottom - 60;
    const zoom = Math.log2(Math.min(
      width / (((Math.max(...lngs) - Math.min(...lngs)) / 360) * 512),
      height / ((south - north) * 512)));
    const midY = (north + south) / 2;
    const midLat = (360 / Math.PI) * Math.atan(Math.exp((0.5 - midY) * 2 * Math.PI)) - 90;
    const midLng = (Math.max(...lngs) + Math.min(...lngs)) / 2;
    return { center: [midLng, midLat], zoom: Math.min(zoom, 4.2), pitch: 0, bearing: 0, padding: pad };
  }

  function cameraFor(i) {
    const chapter = chapters[i];
    if (chapter.type !== "stop") return overviewCamera();
    const c = chapter.stop.camera || {};
    // A chapter can set its own phone view ("phoneZoom", "phoneCenter")
    // when the usual one cuts off labels at the edges.
    const phone = isPhone();
    return {
      center: (phone && c.phoneCenter) || c.center || chapter.stop.coords,
      // Phones only show the top half of the map, so tilt less there,
      // or the city ends up small near the horizon.
      zoom: phone && c.phoneZoom ? c.phoneZoom : (c.zoom || 13) - (phone ? 0.2 : 0),
      pitch: Math.min(c.pitch ?? 55, isPhone() ? 52 : 90),
      bearing: c.bearing ?? 0,
      padding: padding(),
    };
  }

  function flightDuration(from, to) {
    if (reduceMotion) return 0;
    const a = map.getCenter();
    const b = maplibregl.LngLat.convert(cameraFor(to).center);
    const km = a.distanceTo(b) / 1000;
    return Math.round(Math.min(7000, Math.max(3200, 2600 + km * 1.1)));
  }

  // A slow turn around the city, done frame by frame. One long easeTo would
  // freeze the ground height for its whole run, so a turn that started
  // before the hills loaded would stay aimed at sea level, with the city
  // off the top of the screen.
  let orbitFrame = 0;

  function startOrbit(token) {
    stopOrbit();
    if (reduceMotion) return;
    setTimeout(() => {
      if (token !== navToken) return;
      let last = performance.now();
      const step = (now) => {
        if (token !== navToken || !$("#modal").hidden) return;
        map.setBearing(map.getBearing() + (0.3 * (now - last)) / 1000);
        last = now;
        orbitFrame = requestAnimationFrame(step);
      };
      orbitFrame = requestAnimationFrame(step);
    }, 1200);
  }

  function stopOrbit() {
    cancelAnimationFrame(orbitFrame);
  }

  // ---------- Moving between chapters ----------

  function go(i, instant = false) {
    if (i < 0 || i >= chapters.length || !map.getSource("route")) return;
    const from = index;
    index = i;
    const token = ++navToken;
    try { history.replaceState(null, "", "#" + chapters[i].id); } catch (e) { /* file:// */ }

    closeModal();
    stopOrbit();
    closePorthole(true);
    hideCard();
    clearPlaces();
    clearActiveLeg();
    updateNav();
    markStops();
    setCityColors(chapters[i]);

    const chapter = chapters[i];
    const forward = !instant && i === from + 1 && chapter.type === "stop";
    setRoute(forward ? chapter.stopIndex - 1 : chapter.stopIndex);

    const camera = cameraFor(i);
    if (instant) {
      map.jumpTo(camera);
      arrive(i, token);
      return;
    }
    const duration = flightDuration(from, i);
    let settle = duration;
    if (forward && duration > 0) {
      animateLeg(chapter.stopIndex - 1, duration, token);
      settle = Math.max(duration, showWindows(chapter, duration, token));
    }
    map.flyTo({ ...camera, duration, curve: 1.5, essential: true });
    setTimeout(() => {
      if (token !== navToken) return;
      setRoute(chapter.stopIndex);
      clearActiveLeg();
      arrive(i, token);
    }, settle + 80);
  }

  // ---------- Airplane windows ----------

  // Photos taken from the plane open in a porthole at the point on the
  // flight where they were taken. Returns when the last one closes, so the
  // city chapter waits for it.
  const WINDOW_MS = 2800;
  let portholeShown = 0;

  function showWindows(chapter, duration, token) {
    const coords = legs[chapter.stopIndex - 1].coords;
    const along = (at) => {
      if (!at) return 1;
      let best = 0;
      let bestDist = Infinity;
      coords.forEach(([x, y], k) => {
        const d = (x - at[0]) ** 2 + (y - at[1]) ** 2;
        if (d < bestDist) { bestDist = d; best = k; }
      });
      return best / (coords.length - 1);
    };
    const windows = (chapter.stop.windows || []).map((photo) => ({ photo, f: along(photo.at) }))
      .sort((a, b) => a.f - b.f);
    let end = 0;
    for (const { photo, f } of windows) {
      const start = Math.max(f * duration - WINDOW_MS * 0.3, end + 200, 250);
      end = start + WINDOW_MS;
      photoUrl(photo.id);
      setTimeout(() => { if (token === navToken) openPorthole(photo); }, start);
      setTimeout(() => { if (token === navToken) closePorthole(); }, end - 450);
    }
    return end;
  }

  async function openPorthole(photo) {
    const el = $("#porthole");
    const shown = ++portholeShown;
    const img = el.querySelector("img");
    img.src = await photoUrl(photo.id);
    if (shown !== portholeShown) return;
    el.querySelector(".porthole-caption").textContent = photo.caption || "";
    el.classList.toggle("car", photo.frame === "car" || photo.frame === "boat");
    el.classList.toggle("boat", photo.frame === "boat");
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("shown"));
  }

  function closePorthole(instant = false) {
    const el = $("#porthole");
    const shown = ++portholeShown;
    el.classList.remove("shown");
    if (instant) el.hidden = true;
    else setTimeout(() => { if (shown === portholeShown) el.hidden = true; }, 450);
  }

  // A small porthole-shaped thumbnail that opens the photo viewer.
  function windowThumb(photo, onOpen) {
    const b = el("button", { car: "window-thumb car", boat: "window-thumb car boat" }[photo.frame] || "window-thumb");
    b.type = "button";
    b.setAttribute("aria-label", `See photo: ${photo.caption || "from the window"}`);
    const img = document.createElement("img");
    img.alt = "";
    b.append(img);
    photoUrl(photo.id).then((url) => { img.src = url; }).catch(() => {});
    b.addEventListener("click", () => onOpen(b));
    return b;
  }

  // A small box of plain facts, like a boarding pass stub: flight times,
  // or the hike's distance and height.
  function factBox(facts) {
    const box = el("div", "flight");
    box.append(el("p", "flight-label", facts.label));
    const rows = el("dl");
    facts.rows.forEach(([name, value]) => rows.append(el("dt", "", name), el("dd", "", value)));
    box.append(rows);
    if (facts.note) box.append(el("p", "flight-note", facts.note));
    return box;
  }

  // Each chapter has its own accent (card, pins, route). Antigua's buildings
  // get a patchwork of its façade colours. (The map data merges most of the
  // town's buildings into a few big shapes, so colouring by building would
  // paint whole districts one colour.)
  function setCityColors(chapter) {
    const stop = chapter.stop && chapter.type === "stop" ? chapter.stop : null;
    const color = (stop && stop.color) || (chapter.type === "outro" ? story.outro.color : story.intro.color) || COLORS.cochineal;
    const root = document.documentElement.style;
    root.setProperty("--accent", color);
    root.setProperty("--accent-ink", mix(color, "#1d1f45", 0.4));
    map.setPaintProperty("route-active", "line-color", color);
    map.setPaintProperty("buildings", "fill-extrusion-pattern", stop && stop.painted ? "facades" : undefined);
    map.setLayoutProperty("villages", "visibility", stop && stop.villages ? "none" : "visible");
  }

  // A tile of small blocks in façade colours, with thin indigo lines
  // between them so they read as separate houses.
  function addFacadePattern() {
    const cell = 7, cells = 12, size = cell * cells;
    const data = new Uint8Array(size * size * 4);
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const rgb = FACADES.map((h) => h.match(/\w\w/g).map((v) => parseInt(v, 16)));
    const colours = Array.from({ length: cells * cells }, () => rgb[Math.floor(random() * rgb.length)]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const edge = x % cell === 0 || y % cell === 0;
        const c = edge ? [70, 66, 110] : colours[Math.floor(y / cell) * cells + Math.floor(x / cell)];
        data.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
      }
    }
    map.addImage("facades", { width: size, height: size, data });
  }

  function mix(a, b, t) {
    const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
    const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
    return "#" + pa.map((v, k) => Math.round(v * (1 - t) + pb[k] * t).toString(16).padStart(2, "0")).join("");
  }

  function arrive(i, token) {
    showCard(chapters[i]);
    if (chapters[i].type === "stop") {
      showPlaces(chapters[i].stop);
      startOrbit(token);
    }
  }

  function updateNav() {
    const prev = chapters[index - 1];
    const next = chapters[index + 1];
    const label = (c) => (c.type === "intro" ? "Start" : c.type === "outro" ? "The end" : c.stop.name);
    const prevBtn = $("#prev");
    const nextBtn = $("#next");

    prevBtn.disabled = !prev;
    prevBtn.querySelector(".arrow-label").textContent = prev ? label(prev) : "";
    prevBtn.setAttribute("aria-label", prev ? `Back to ${label(prev)}` : "Back");

    const nextText = next ? label(next) : "Start again";
    nextBtn.querySelector(".arrow-label").innerHTML = next ? `<span class="verb">Next: </span>` : "";
    nextBtn.querySelector(".arrow-label").append(nextText);
    nextBtn.setAttribute("aria-label", next ? `Next: ${nextText}` : "Start again");

    const total = chapters.length - 2;
    const chapter = chapters[index];
    $("#progress").textContent = chapter.type === "intro" ? "The journey"
      : chapter.type === "outro" ? "The end" : `Stop ${index} of ${total}`;
  }

  $("#prev").addEventListener("click", () => go(index - 1));
  $("#next").addEventListener("click", () => go(index + 1 < chapters.length ? index + 1 : 0));

  document.addEventListener("keydown", (e) => {
    if (!map || e.target.tagName === "INPUT") return;
    const modalOpen = !$("#modal").hidden;
    if (e.key === "Escape" && modalOpen) closeModal();
    else if (e.key === "ArrowRight") modalOpen ? stepPhoto(1) : $("#next").click();
    else if (e.key === "ArrowLeft") modalOpen ? stepPhoto(-1) : (index > 0 && go(index - 1));
  });

  // ---------- Story card ----------

  function paragraphs(list) {
    const frag = document.createDocumentFragment();
    (list || []).forEach((t) => {
      const p = document.createElement("p");
      p.textContent = t;
      frag.append(p);
    });
    return frag;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function showCard(chapter) {
    const body = $("#card-body");
    body.replaceChildren();
    const card = $("#card");
    card.classList.remove("collapsed");
    $("#card-toggle").textContent = "Hide the story";

    if (chapter.type === "intro") {
      const intro = story.intro;
      body.append(el("p", "eyebrow", "A Travel Story"), el("h1", "", story.title), el("p", "sub", story.subtitle));
      const section = el("p", "eyebrow chapter-start", `${intro.theme}: ${intro.name}`);
      const text = el("div", "text");
      if (intro.photo) {
        text.append(windowThumb(intro.photo, (b) =>
          openPlace({ name: intro.name }, { title: "From the window", photos: [intro.photo] }, b)));
      }
      text.append(paragraphs(intro.text));
      body.append(section, text);
      const help = el("div", "section");
      help.append(el("p", "hint", intro.hint), el("p", "legend", intro.legend));
      body.append(help);
    } else if (chapter.type === "outro") {
      body.append(el("p", "eyebrow", story.outro.theme), el("h2", "", story.title));
      const text = el("div", "text");
      text.append(paragraphs(story.outro.text));
      body.append(text);
    } else {
      const stop = chapter.stop;
      body.append(el("p", "eyebrow", stop.theme), el("h2", "", stop.name), el("p", "dates", stop.dates));
      const text = el("div", "text");
      text.append(paragraphs(stop.text));
      body.append(text);
      if ((stop.windows && stop.windows.length) || stop.facts) {
        const section = el("div", "section");
        if (stop.windows && stop.windows.length) {
          const frames = new Set(stop.windows.map((w) => w.frame || "plane"));
          const label = frames.size > 1 ? "On the way:" : `From the ${[...frames][0]} window:`;
          section.append(el("p", "places-intro", label));
          const row = el("div", "window-row");
          stop.windows.forEach((photo, n) => row.append(windowThumb(photo, (b) =>
            openPlace(stop, { title: "From the window", photos: stop.windows, start: n }, b))));
          section.append(row);
        }
        if (stop.facts) section.append(factBox(stop.facts));
        body.append(section);
      }
      const places = stop.places || [];
      if (places.length || stop.villages || stop.essay) {
        const section = el("div", "section");
        section.append(el("p", "places-intro", places.length
          ? `Tap a place to see photos from ${stop.name}:`
          : "Tap a coloured village on the map, or start here:"));
        const list = el("div", "place-list");
        places.forEach((place) => {
          const b = el("button", "place-button", place.label);
          b.type = "button";
          b.addEventListener("click", () => openPlace(stop, place, b));
          list.append(b);
        });
        if (stop.villages) {
          const b = el("button", "place-button village-button village-toggle", stop.villages.button || stop.villages.title);
          b.type = "button";
          b.setAttribute("aria-pressed", "false");
          b.addEventListener("click", () => toggleTowns(stop, b));
          list.append(b);
        }
        if (stop.essay) {
          const b = el("button", "place-button essay-button", stop.essay.button || stop.essay.title);
          b.type = "button";
          b.addEventListener("click", () => openEssay(stop, b));
          list.append(b);
        }
        section.append(list);
        body.append(section);
      }
    }
    card.hidden = false;
    card.scrollTop = 0;
    requestAnimationFrame(() => card.classList.add("shown"));
  }

  function hideCard() {
    const card = $("#card");
    card.classList.remove("shown");
    card.hidden = true;
  }

  $("#card-toggle").addEventListener("click", () => {
    const card = $("#card");
    const collapsed = card.classList.toggle("collapsed");
    $("#card-toggle").textContent = collapsed ? "Show the story" : "Hide the story";
  });

  // ---------- Places on the map ----------

  function showPlaces(stop) {
    ((stop.trail && stop.trail.pins) || []).forEach((pin, n) => {
      // "side": "left" puts the label on the left of its dot, for pins
      // that would otherwise sit on top of a neighbour's label.
      const left = pin.side === "left";
      const pinEl = el("div", left ? "trail-pin left" : "trail-pin");
      pinEl.append(el("span", "dot"), el("span", "name", pin.label), el("span", "sub", pin.sub));
      const marker = new maplibregl.Marker({ element: pinEl, anchor: left ? "right" : "left", offset: [left ? 6 : -6, 0] })
        .setLngLat(pin.coords).addTo(map);
      placeMarkers.push(marker);
      setTimeout(() => pinEl.classList.add("shown"), 150 + n * 180);
    });
    (stop.places || []).forEach((place, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "place-marker";
      b.innerHTML = `<span class="label"></span><span class="stem"></span><span class="pin"></span>`;
      // Stems of different lengths, so nearby labels stack instead of overlapping.
      // A place can set its own "lift" when its neighbours still crowd it.
      const lift = place.lift ?? 16 + 30 * (n % 3);
      b.querySelector(".stem").style.height = `${lift}px`;
      // Lower labels sit on top, so a taller neighbour's stem passes behind them.
      b.style.zIndex = String(300 - lift);
      b.querySelector(".label").textContent = place.label;
      b.setAttribute("aria-label", `See photos: ${place.label}`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        openPlace(stop, place, b);
      });
      const marker = new maplibregl.Marker({ element: b, anchor: "bottom" }).setLngLat(place.coords).addTo(map);
      b.classList.add("event-pin");
      placeMarkers.push(marker);
      setTimeout(() => b.classList.add("shown"), 150 + n * 180);
    });
    // The villages get their own pin out on the water. It looks different
    // from Shaun's places, because it is background, not something he did.
    if (stop.villages && stop.villages.coords) {
      const b = el("button", "village-marker village-toggle");
      b.type = "button";
      b.append(el("span", "dot"), el("span", "label", stop.villages.button || stop.villages.title));
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleTowns(stop, b);
      });
      const marker = new maplibregl.Marker({ element: b, anchor: "center" }).setLngLat(stop.villages.coords).addTo(map);
      placeMarkers.push(marker);
      setTimeout(() => b.classList.add("shown"), 150 + (stop.places || []).length * 180);
    }
    // A background essay (Asturias in Guatemala City) gets one chip too.
    if (stop.essay && stop.essay.coords) {
      const b = el("button", "essay-marker");
      b.type = "button";
      b.append(el("span", "dot"), el("span", "label", stop.essay.button || stop.essay.title));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        openEssay(stop, b);
      });
      const marker = new maplibregl.Marker({ element: b, anchor: "center" }).setLngLat(stop.essay.coords).addTo(map);
      placeMarkers.push(marker);
      setTimeout(() => b.classList.add("shown"), 150 + (stop.places || []).length * 180);
    }
  }

  function clearPlaces() {
    placeMarkers.forEach((m) => m.remove());
    placeMarkers = [];
    townMarkers.forEach((m) => m.remove());
    townMarkers = [];
    villageStoryShown = false;
  }

  // Shows or hides the ring of village dots. While they show, Shaun's own
  // place pins step aside so the two kinds of marker don't mix.
  function toggleTowns(stop, button) {
    const on = !townMarkers.length;
    document.querySelectorAll(".event-pin").forEach((pin) => { pin.hidden = on; });
    // The card button and the map pin both switch the villages, so both
    // change their wording together.
    document.querySelectorAll(".village-toggle").forEach((toggle) => {
      (toggle.querySelector(".label") || toggle).textContent = on ? "Hide the villages" : stop.villages.button || stop.villages.title;
      toggle.setAttribute("aria-pressed", String(on));
    });
    if (!on) {
      townMarkers.forEach((m) => m.remove());
      townMarkers = [];
      return;
    }
    stop.villages.towns.forEach((town, n) => {
      const left = town.side === "left";
      const b = el("button", left ? "town-pin left" : "town-pin");
      b.type = "button";
      const dot = el("span", town.color ? "dot" : "dot unknown");
      if (town.color) paintCloth(dot, town);
      b.append(dot, el("span", "name", town.short || town.name));
      b.setAttribute("aria-label", `${town.name}: ${town.language}, ${town.colours}`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        openTown(stop, town, b);
      });
      const marker = new maplibregl.Marker({ element: b, anchor: left ? "right" : "left", offset: [left ? 8 : -8, 0] })
        .setLngLat(town.coords).addTo(map);
      townMarkers.push(marker);
      setTimeout(() => b.classList.add("shown"), 100 + n * 70);
    });
    // The story opens the first time, so the colours make sense.
    if (!villageStoryShown) {
      villageStoryShown = true;
      openVillages(stop, button);
    }
  }

  // ---------- Photo pop-up ----------

  async function photoUrl(id) {
    if (!photoUrls.has(id)) {
      photoUrls.set(id, (async () => {
        const plain = await decrypt(await fetchBytes(`data/photos/${id}.bin`));
        return URL.createObjectURL(new Blob([plain], { type: "image/jpeg" }));
      })());
    }
    return photoUrls.get(id);
  }

  function openPlace(stop, place, trigger) {
    stopOrbit();
    modalReturnFocus = trigger;
    $("#modal-eyebrow").textContent = stop.name;
    $("#modal-title").textContent = place.title || place.label;
    $("#modal-text").replaceChildren(paragraphs(place.text));
    $("#modal-extra").replaceChildren(...(place.herbs ? [herbSection(place.herbs)] : []));

    const track = $("#track");
    track.replaceChildren();
    track.scrollLeft = 0;
    modalPhotos = place.photos || [];
    (place.photos || []).forEach((photo) => {
      const fig = el("figure", "slide");
      const frame = el("div", "frame");
      const img = document.createElement("img");
      img.alt = photo.caption || place.label;
      img.width = photo.w;
      img.height = photo.h;
      frame.append(img);
      fig.append(frame);
      if (photo.caption) fig.append(el("figcaption", "", photo.caption));
      track.append(fig);
      photoUrl(photo.id).then((url) => {
        img.onload = () => img.classList.add("ready");
        img.src = url;
      }).catch(() => { img.alt = "This photo couldn't be loaded."; });
    });
    $(".photo-nav").hidden = false;
    const many = (place.photos || []).length > 1;
    $(".photo-nav").hidden = !many;
    $("#track").hidden = !(place.photos || []).length;
    updatePhotoCount();

    $("#modal").hidden = false;
    // Only once the pop-up is showing does the browser accept a scroll
    // position. Set while hidden, it is ignored, and the strip reopens
    // wherever the last pop-up was left.
    photoTarget = null;
    $(".modal-card").scrollTop = 0;
    track.scrollTo({ left: (place.start || 0) * track.clientWidth, behavior: "instant" });
    updatePhotoCount();
    $("#modal .close").focus({ preventScroll: true });
  }

  // Elena's herbs for the temazcal: her recipe, then one old engraving per
  // plant with its names and what it is used for. It sits below the photo
  // notes, so it stays put while the photos are swiped.
  function herbSection(herbs) {
    const section = el("section", "herbs");
    section.append(el("h3", "", herbs.title));
    if (herbs.intro) section.append(el("p", "", herbs.intro));
    if (herbs.recipe) {
      const steps = el("ol", "recipe");
      herbs.recipe.forEach((step) => steps.append(el("li", "", step)));
      section.append(steps);
    }
    const list = el("ul", "herb-list");
    herbs.items.forEach((herb) => {
      const li = el("li", herb.image ? "herb" : "herb no-plate");
      if (herb.image) {
        const plate = el("figure", "herb-plate");
        const img = document.createElement("img");
        img.alt = `Old engraving of ${herb.english.toLowerCase()}`;
        img.width = herb.image.w;
        img.height = herb.image.h;
        plate.append(img);
        li.append(plate);
        photoUrl(herb.image.id).then((url) => {
          img.onload = () => img.classList.add("ready");
          img.src = url;
        }).catch(() => { img.alt = "This engraving couldn't be loaded."; });
      }
      const words = el("div", "herb-words");
      words.append(
        el("p", "herb-name", herb.maya || herb.spanish),
        el("p", "herb-also", herb.maya ? `${herb.spanish} · ${herb.english}` : herb.english),
        el("p", "herb-note", herb.note),
      );
      if (herb.credit) words.append(el("p", "herb-credit", herb.credit));
      li.append(words);
      list.append(li);
    });
    section.append(list);
    return section;
  }

  function openInfo(eyebrow, title, content, trigger) {
    stopOrbit();
    modalReturnFocus = trigger;
    modalPhotos = [];
    $("#modal-eyebrow").textContent = eyebrow;
    $("#modal-title").textContent = title;
    $("#modal-text").replaceChildren(content);
    $("#modal-extra").replaceChildren();
    $("#track").replaceChildren();
    $("#track").hidden = true;
    $(".photo-nav").hidden = true;
    $("#modal").hidden = false;
    $(".modal-card").scrollTop = 0;
    updatePhotoCount();
    $("#modal .close").focus({ preventScroll: true });
  }

  // A small piece of each town's huipil, drawn as a repeating SVG tile from
  // `pattern` in story.json, so the lake's many reds don't all look alike.
  function clothTile(p) {
    const c = p.colors || [];
    const svg = (w, h, body) => ({
      w, h,
      image: `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>${body}</svg>`)}")`,
    });
    switch (p.kind) {
      case "stripes": {
        let x = 0;
        const body = c.map((col, i) => {
          const rect = `<rect x='${x}' width='${p.widths[i]}' height='4' fill='${col}'/>`;
          x += p.widths[i];
          return rect;
        }).join("");
        return svg(x, 4, body);
      }
      // One band of triangles, like the ones at a huipil's neck.
      case "triangles":
        return { ...svg(12, 12, `<polygon points='0,9 3,3 6,9' fill='${c[0]}'/><polygon points='6,9 9,3 12,9' fill='${c[1]}'/><rect y='10' width='12' height='1' fill='${c[0]}'/>`), repeat: "repeat-x" };
      case "squares":
        return svg(25, 12, c.map((col, i) =>
          `<rect x='${1 + i * 5}' y='1.5' width='3' height='3' fill='${col}'/><rect x='${3.5 + i * 5}' y='7.5' width='3' height='3' fill='${c[(i + 2) % c.length]}'/>`).join(""));
      case "waves":
        return svg(12, 8, `<path d='M0 4 Q3 1.2 6 4 T12 4' fill='none' stroke='${c[0]}' stroke-width='1.4'/>`);
      case "diamonds":
        return svg(10, 10, `<polygon points='5,1 9,5 5,9 1,5' fill='${c[0]}'/><polygon points='5,3.5 6.5,5 5,6.5 3.5,5' fill='${c[1]}'/>`);
      case "dots":
        return svg(8, 8, `<circle cx='2' cy='2' r='1.1' fill='${c[0]}'/><circle cx='6' cy='6' r='1.1' fill='${c[1]}'/>`);
    }
    return null;
  }

  function paintCloth(node, town, scale = 1) {
    const tile = town.pattern && clothTile(town.pattern);
    if (!tile) {
      node.style.background = town.color;
      return;
    }
    const layers = [`${tile.image} center / ${tile.w * scale}px ${tile.h * scale}px ${tile.repeat || "repeat"}`];
    // Panajachel's red huipil is worn with a blue skirt.
    if (town.pattern.skirt) layers.unshift(`linear-gradient(transparent 64%, ${town.pattern.skirt} 64%)`);
    node.style.background = `${layers.join(", ")} ${town.pattern.ground || town.color}`;
  }

  function swatch(town, scale) {
    const s = el("span", town.color ? "swatch" : "swatch unknown");
    if (town.color) paintCloth(s, town, scale);
    return s;
  }

  function openVillages(stop, trigger) {
    const frag = document.createDocumentFragment();
    frag.append(paragraphs(stop.villages.text));
    const list = el("ul", "town-list");
    stop.villages.towns.forEach((town) => {
      const b = el("button", "town-row");
      b.type = "button";
      const words = el("span", "town-words");
      words.append(el("span", "town-name", town.name), el("span", "town-meta", `${town.language} · ${town.colours}`));
      b.append(swatch(town), words);
      b.addEventListener("click", () => openTown(stop, town, trigger));
      const li = el("li");
      li.append(b);
      list.append(li);
    });
    frag.append(list);
    openInfo(stop.name, stop.villages.title, frag, trigger);
  }

  function openTown(stop, town, trigger) {
    const frag = document.createDocumentFragment();
    // The wide bar shows the cloth twice as large.
    const bar = swatch(town, 2);
    bar.classList.add("swatch-bar");
    const facts = el("dl", "town-facts");
    facts.append(el("dt", "", "Language"), el("dd", "", town.language), el("dt", "", "Colours"), el("dd", "", town.colours));
    const all = el("button", "text-button", "See all the villages and their story");
    all.type = "button";
    all.addEventListener("click", () => openVillages(stop, trigger));
    frag.append(bar, facts, paragraphs([town.note]), all);
    openInfo(stop.villages.title, town.name, frag, trigger);
  }

  // Loads an encrypted image into an <img> once the pop-up has it on screen.
  function fillImage(img, photo, alt) {
    img.alt = alt;
    img.width = photo.w;
    img.height = photo.h;
    photoUrl(photo.id).then((url) => {
      img.onload = () => img.classList.add("ready");
      img.src = url;
    }).catch(() => { img.alt = "This image couldn't be loaded."; });
    return img;
  }

  function openEssay(stop, trigger) {
    const essay = stop.essay;
    const frag = document.createDocumentFragment();
    if (essay.portrait) {
      const fig = el("figure", "essay-portrait");
      fig.append(fillImage(document.createElement("img"), essay.portrait, "Portrait of Miguel Ángel Asturias"));
      if (essay.portrait.caption) fig.append(el("figcaption", "", essay.portrait.caption));
      frag.append(fig);
    }
    frag.append(paragraphs(essay.text));
    const list = el("ol", "book-list");
    (essay.books || []).forEach((book) => {
      const li = el("li", "book");
      const cover = el("figure", "book-cover");
      if (book.cover) cover.append(fillImage(document.createElement("img"), book.cover, `Cover of ${book.title}`));
      const words = el("div", "book-words");
      words.append(el("h3", "", book.title), el("p", "book-meta", `${book.year} · ${book.english}`), paragraphs(book.text));
      if (book.credit) words.append(el("p", "book-credit", book.credit));
      li.append(cover, words);
      list.append(li);
    });
    frag.append(list, paragraphs(essay.end));
    openInfo(stop.name, essay.title, frag, trigger);
  }

  function closeModal() {
    if ($("#modal").hidden) return;
    $("#modal").hidden = true;
    if (modalReturnFocus && document.body.contains(modalReturnFocus)) modalReturnFocus.focus();
    modalReturnFocus = null;
  }

  function currentPhoto() {
    const track = $("#track");
    return Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  }

  // The photo on screen can have its own title and note (the museum pieces
  // and buildings do). They sit under the photo and change as you swipe.
  function updatePhotoCount() {
    const total = $("#track").children.length;
    const n = Math.min(total, currentPhoto() + 1);
    $("#photo-count").textContent = `Photo ${n} of ${total}`;
    $("#photo-prev").disabled = n <= 1;
    $("#photo-next").disabled = n >= total;
    // The place's introduction only opens the first photo, so it isn't
    // repeated under every one.
    $("#modal-text").hidden = n > 1;
    const photo = modalPhotos[n - 1] || {};
    const note = $("#photo-note");
    if (note.dataset.shown === String(n) + (photo.id || "")) return;
    note.dataset.shown = String(n) + (photo.id || "");
    note.replaceChildren();
    if (photo.title) note.append(el("h3", "", photo.title));
    if (photo.note) note.append(paragraphs(photo.note.split("\n\n")));
    note.hidden = !photo.title && !photo.note;
  }

  // Quick repeated taps count from where the last tap was heading,
  // not from where the smooth scroll has got to so far.
  let photoTarget = null;
  let photoTargetTimer = 0;

  function stepPhoto(dir) {
    const track = $("#track");
    const last = track.children.length - 1;
    photoTarget = Math.max(0, Math.min(last, (photoTarget ?? currentPhoto()) + dir));
    track.scrollTo({ left: photoTarget * track.clientWidth, behavior: reduceMotion ? "auto" : "smooth" });
    clearTimeout(photoTargetTimer);
    photoTargetTimer = setTimeout(() => { photoTarget = null; }, 700);
  }

  $("#track").addEventListener("scroll", () => requestAnimationFrame(updatePhotoCount), { passive: true });
  $("#photo-prev").addEventListener("click", () => stepPhoto(-1));
  $("#photo-next").addEventListener("click", () => stepPhoto(1));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));

  init().catch((e) => {
    $("#lock-error").textContent = "The story couldn't load. Please refresh the page.";
    console.error(e);
  });
})();
