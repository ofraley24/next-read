'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const handlers = require('./lib/handlers');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const APP_PASSCODE = defineSecret('APP_PASSCODE'); // stops strangers spending your API credits

exports.api = onRequest(
  { region: 'europe-west2', secrets: [ANTHROPIC_API_KEY, APP_PASSCODE], timeoutSeconds: 300, memory: '512MiB', maxInstances: 3 },
  async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      if (req.get('x-passcode') !== APP_PASSCODE.value()) return res.status(401).json({ error: 'Wrong passcode' });
      process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY.value();
      const route = req.path.replace(/\/+$/, '');
      if (route === '/api/profile') return res.json(await handlers.profile(req.body || {}));
      if (route === '/api/recommend') return res.json(await handlers.recommend(req.body || {}));
      return res.status(404).json({ error: 'Not found' });
    } catch (e) {
      console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Server error' });
    }
  }
);
