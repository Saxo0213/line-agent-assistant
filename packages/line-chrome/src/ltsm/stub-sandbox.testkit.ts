// A stub standing in for ltsmSandbox.js: it mimics the postMessage protocol and the init order of the real bundle
// (listener registered on DOMContentLoaded only when ?sandboxId= is present, `loaded` message, origin check on init) so
// the bridge shim can be tested without any LINE file. Not part of the package build.

export const STUB_SANDBOX = String.raw`
(function () {
  var log = [];
  var inited = false;
  function post(sandboxId, type, data) { window.parent.postMessage({ sandboxId: sandboxId, type: type, data: data }, '*'); }
  async function onMessage(e) {
    var m = e.data;
    if (!m || typeof m !== 'object' || m.type !== 'request') return;
    var id = m.sandboxId, cmd = m.data.command, p = m.data.payload;
    log.push(cmd);
    try {
      switch (cmd) {
        case 'init':
          if (window.origin !== 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc') throw new Error('Invalid origin: ' + window.origin);
          inited = true; post(id, 'response'); break;
        case 'get_hmac':
          if (!inited) throw new Error('LTSM_NOT_READY');
          post(id, 'response', 'sig(' + p.accessToken + '|' + p.path + '|' + p.body + ')'); break;
        case 'curvekey_generate': post(id, 'response', 7); break;
        case 'e2eekey_get_public_key': post(id, 'response', new Uint8Array([1, 2, 3, m.data.ltsmKeyId])); break;
        case 'e2eekey_create_channel': post(id, 'response', 40 + p.length); break;
        case 'e2eechannel_unwrap_e2ee_key_chain': post(id, 'response', [5, 6]); break;
        case 'e2eechannel_encrypt_v2':
          post(id, 'response', new Uint8Array([
            p.plaintext instanceof Uint8Array ? 1 : 0, typeof p.sequenceNumber === 'bigint' ? 1 : 0,
            p.senderKeyId, p.receiverKeyId, p.contentType, p.plaintext.length])); break;
        case 'e2eechannel_wrap_group_shared_key': post(id, 'response', new Uint8Array([typeof p === 'number' ? p : 0])); break;
        case 'e2eekey_load_key': post(id, 'response', 99); break;
        case 'dump_log': post(id, 'response', log.join(',')); break;
        case 'env_check':
          post(id, 'response', JSON.stringify({
            encoderRealm: new TextEncoder().encode('e') instanceof Uint8Array,
            search: window.location.search,
            scriptSrc: document.currentScript.src,
            hasProcess: typeof process, hasRequire: typeof require,
            a: (function(){ var a = document.createElement('a'); a.setAttribute('href', '/x'); return a.protocol + a.pathname; })()
          })); break;
        case 'wasm_check': {
          var x = new XMLHttpRequest(); x.open('GET', 'ltsm.wasm', false); x.responseType = 'arraybuffer'; x.send();
          post(id, 'response', x.status + ':' + (x.response instanceof ArrayBuffer) + ':' + x.response.byteLength); break;
        }
        case 'silent': break;
        case 'boom': throw new Error('stub failure');
        case 'named': { var err = new Error(''); err.name = 'NamedFailure'; throw err; }
        default: throw new Error('unknown command ' + cmd);
      }
    } catch (err) { post(id, 'error', err); }
  }
  document.addEventListener('DOMContentLoaded', function () {
    var id = new URLSearchParams(window.location.search).get('sandboxId');
    if (id) { window.addEventListener('message', onMessage); post(id, 'loaded'); }
  }, false);
})();
`;
