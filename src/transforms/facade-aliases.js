/**
 * Transform: Replace global facade aliases with fully qualified names
 * Ported from Laravel Shift CLI (MIT)
 */

const FACADE_MAP = {
  App: 'Illuminate\\Support\\Facades\\App',
  Artisan: 'Illuminate\\Support\\Facades\\Artisan',
  Auth: 'Illuminate\\Support\\Facades\\Auth',
  Blade: 'Illuminate\\Support\\Facades\\Blade',
  Broadcast: 'Illuminate\\Support\\Facades\\Broadcast',
  Bus: 'Illuminate\\Support\\Facades\\Bus',
  Cache: 'Illuminate\\Support\\Facades\\Cache',
  Config: 'Illuminate\\Support\\Facades\\Config',
  Cookie: 'Illuminate\\Support\\Facades\\Cookie',
  Crypt: 'Illuminate\\Support\\Facades\\Crypt',
  Date: 'Illuminate\\Support\\Facades\\Date',
  DB: 'Illuminate\\Support\\Facades\\DB',
  Eloquent: 'Illuminate\\Database\\Eloquent\\Model',
  Event: 'Illuminate\\Support\\Facades\\Event',
  File: 'Illuminate\\Support\\Facades\\File',
  Gate: 'Illuminate\\Support\\Facades\\Gate',
  Hash: 'Illuminate\\Support\\Facades\\Hash',
  Http: 'Illuminate\\Support\\Facades\\Http',
  Js: 'Illuminate\\Support\\Js',
  Lang: 'Illuminate\\Support\\Facades\\Lang',
  Log: 'Illuminate\\Support\\Facades\\Log',
  Mail: 'Illuminate\\Support\\Facades\\Mail',
  Notification: 'Illuminate\\Support\\Facades\\Notification',
  Password: 'Illuminate\\Support\\Facades\\Password',
  Queue: 'Illuminate\\Support\\Facades\\Queue',
  RateLimiter: 'Illuminate\\Support\\Facades\\RateLimiter',
  Redirect: 'Illuminate\\Support\\Facades\\Redirect',
  Redis: 'Illuminate\\Support\\Facades\\Redis',
  Request: 'Illuminate\\Support\\Facades\\Request',
  Response: 'Illuminate\\Support\\Facades\\Response',
  Route: 'Illuminate\\Support\\Facades\\Route',
  Schema: 'Illuminate\\Support\\Facades\\Schema',
  Session: 'Illuminate\\Support\\Facades\\Session',
  Storage: 'Illuminate\\Support\\Facades\\Storage',
  Str: 'Illuminate\\Support\\Str',
  URL: 'Illuminate\\Support\\Facades\\URL',
  Validator: 'Illuminate\\Support\\Facades\\Validator',
  View: 'Illuminate\\Support\\Facades\\View',
  Vite: 'Illuminate\\Support\\Facades\\Vite',
};

export default {
  name: 'facade-aliases',
  description: 'Replace global facade aliases with fully qualified imports',
  appliesFrom: '8',
  appliesTo: null,
  glob: '{app,src}/**/*.php',

  detect(content) {
    const aliases = Object.keys(FACADE_MAP).join('|');
    const regex = new RegExp(`^use\\s+(${aliases})\\s*;`, 'm');
    return regex.test(content);
  },

  transform(content) {
    let count = 0;
    const aliases = Object.keys(FACADE_MAP).join('|');
    const regex = new RegExp(`^(use\\s+)(${aliases})(\\s*;)`, 'gm');

    const transformed = content.replace(regex, (_match, prefix, alias, suffix) => {
      const fqn = FACADE_MAP[alias];
      if (fqn) {
        count++;
        return `${prefix}${fqn}${suffix}`;
      }
      return _match;
    });

    return {
      content: transformed,
      changed: count > 0,
      description: count > 0 ? `Replaced ${count} facade alias(es) with FQN imports` : '',
    };
  },
};

export { FACADE_MAP };
