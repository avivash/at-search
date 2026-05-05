export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["favicon.svg"]),
	mimeTypes: {".svg":"image/svg+xml"},
	_: {
		client: {start:"_app/immutable/entry/start.DQV2cCJZ.js",app:"_app/immutable/entry/app.Dxht11pL.js",imports:["_app/immutable/entry/start.DQV2cCJZ.js","_app/immutable/chunks/BUzXQhrq.js","_app/immutable/chunks/CbOb078r.js","_app/immutable/entry/app.Dxht11pL.js","_app/immutable/chunks/CbOb078r.js","_app/immutable/chunks/_YvfHFkN.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
