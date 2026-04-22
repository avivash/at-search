

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const universal = {
  "ssr": false,
  "prerender": false
};
export const universal_id = "src/routes/+layout.ts";
export const imports = ["_app/immutable/nodes/0.D2EGiEWl.js","_app/immutable/chunks/CbOb078r.js","_app/immutable/chunks/_YvfHFkN.js"];
export const stylesheets = ["_app/immutable/assets/0.CSvLAFTf.css"];
export const fonts = [];
