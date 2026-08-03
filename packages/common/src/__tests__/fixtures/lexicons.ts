/** Real-world lexicon documents (trimmed to the fields that matter structurally). */

export const LIKE_LEXICON = {
  lexicon: 1,
  id: 'app.bsky.feed.like',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['subject', 'createdAt'],
        properties: {
          subject: { type: 'ref', ref: 'com.atproto.repo.strongRef' },
          createdAt: { type: 'string', format: 'datetime' },
        },
      },
    },
  },
}

export const WHTWND_LEXICON = {
  lexicon: 1,
  id: 'com.whtwnd.blog.entry',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      description: 'A blog entry on WhiteWind',
      record: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', maxLength: 100000 },
          title: { type: 'string', maxLength: 1000 },
          subtitle: { type: 'string', maxLength: 1000 },
          createdAt: { type: 'string', format: 'datetime' },
          ogp: { type: 'ref', ref: 'com.whtwnd.blog.defs#ogp' },
          theme: { type: 'string', enum: ['github-light'] },
          isDraft: { type: 'boolean' },
          visibility: { type: 'string', enum: ['public', 'url', 'author'], default: 'public' },
        },
      },
    },
  },
}

export const FUNCTIONS_LEXICON = {
  lexicon: 1,
  id: 'at.functions.metadata',
  defs: {
    main: {
      type: 'record',
      key: 'any',
      description: 'A WebAssembly function registered on AT Protocol',
      record: {
        type: 'object',
        required: ['name', 'version', 'mode', 'code', 'entrypoint'],
        properties: {
          name: { type: 'string', maxLength: 128 },
          version: { type: 'string', maxLength: 32 },
          updatedAt: { type: 'string', maxLength: 64 },
          description: { type: 'string', maxLength: 2048 },
          mode: { type: 'string', knownValues: ['pure-v1', 'host-v1', 'component-v1'] },
          code: { type: 'blob', accept: ['application/wasm'] },
          entrypoint: { type: 'string', const: 'run' },
          maxMemoryMb: { type: 'integer', minimum: 1, maximum: 256 },
          public: { type: 'boolean' },
        },
      },
    },
  },
}

export const FRONTPAGE_LEXICON = {
  lexicon: 1,
  id: 'fyi.unravel.frontpage.post',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['title', 'url', 'createdAt'],
        properties: {
          title: { type: 'string', maxGraphemes: 300 },
          url: { type: 'string', format: 'uri' },
          createdAt: { type: 'string', format: 'datetime' },
        },
      },
    },
  },
}

export const LINKBOARD_LEXICON = {
  lexicon: 1,
  id: 'blue.linkat.board',
  defs: {
    main: {
      type: 'record',
      key: 'literal:self',
      record: {
        type: 'object',
        required: ['links'],
        properties: {
          name: { type: 'string', maxLength: 500 },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri' },
                text: { type: 'string', maxLength: 5000 },
              },
            },
          },
        },
      },
    },
  },
}

export const PLACE_LEXICON = {
  lexicon: 1,
  id: 'com.example.place',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', maxLength: 200 },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          langs: { type: 'string', format: 'language' },
          author: { type: 'string', format: 'did' },
          location: {
            type: 'object',
            properties: {
              lat: { type: 'number' },
              lon: { type: 'number' },
              geohash: { type: 'string', maxLength: 12 },
            },
          },
          createdAt: { type: 'string', format: 'datetime' },
        },
      },
    },
  },
}

/** Not a record lexicon — XRPC query. compileExtractionPlan must return null. */
export const QUERY_LEXICON = {
  lexicon: 1,
  id: 'app.bsky.feed.getTimeline',
  defs: {
    main: {
      type: 'query',
      parameters: { type: 'params', properties: { limit: { type: 'integer' } } },
    },
  },
}
