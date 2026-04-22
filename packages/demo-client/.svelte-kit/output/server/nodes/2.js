

export const index = 2;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/2.BLRjxMPg.js","_app/immutable/chunks/CbOb078r.js","_app/immutable/chunks/_YvfHFkN.js"];
export const stylesheets = ["_app/immutable/assets/2.D6py8QYc.css"];
export const fonts = [];
