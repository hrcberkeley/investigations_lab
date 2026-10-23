(function() {
  const pending = new Map();

  function loadStyle(id, href) {
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function loadScript(id, src) {
    if (pending.has(id)) return pending.get(id);
    const existing = document.getElementById(id);
    if (existing && existing.dataset.loaded === 'true') return Promise.resolve();

    const promise = new Promise((resolve, reject) => {
      const script = existing || document.createElement('script');
      script.id = id;
      script.onload = () => {
        script.dataset.loaded = 'true';
        resolve();
      };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      if (!existing) {
        script.src = src;
        document.head.appendChild(script);
      }
    });
    pending.set(id, promise);
    return promise;
  }

  async function loadMapboxRuntime() {
    if (window.mapboxgl) return window.mapboxgl;
    loadStyle('mapboxRuntimeStyle', 'assets/vendor/mapbox-gl/mapbox-gl.css');
    await loadScript('mapboxRuntimeScript', 'assets/vendor/mapbox-gl/mapbox-gl.js');
    window.mapboxgl.workerUrl = 'assets/vendor/mapbox-gl/mapbox-gl-csp-worker.js';
    return window.mapboxgl;
  }

  async function loadPeakFinderRuntime() {
    if (window.PeakFinder && window.PeakFinder.utils) return window.PeakFinder;
    await loadScript('peakFinderRuntimeScript', 'https://www.peakfinder.com/script/peakfinder.1.0.min.js');
    return window.PeakFinder;
  }

  window.loadMapboxRuntime = loadMapboxRuntime;
  window.loadPeakFinderRuntime = loadPeakFinderRuntime;
})();
