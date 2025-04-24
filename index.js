const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const cors = require('cors');
const sharp = require('sharp');

const app = express();
const port = 3000;

const clients = new Map(); // { numero: Client }
const qrSubscribers = {};  // { numero: [res1, res2, ...] }
const authPath = './.wwebjs_auth';
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function getOrCreateClient(numero) {
  if (clients.has(numero)) {
    return clients.get(numero);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: numero }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox']
    }
  });

  client.on('qr', async (qr) => {
    const qrDataUrl = await qrcode.toDataURL(qr);
    console.log(`🔐 QR para ${numero}`);
    sendQRToClients(numero, qrDataUrl);
  });

  client.on('ready', () => {
    console.log(`✅ Cliente ${numero} listo`);
    sendReadySignal(numero);
  });

  client.on('auth_failure', msg => {
    console.error(`❌ Fallo de autenticación para ${numero}:`, msg);
  });

  client.on('disconnected', async (reason) => {
    console.log(`🔌 Cliente ${numero} desconectado:`, reason);
    await client.destroy();
    clients.delete(numero);
  });

  client.initialize();
  clients.set(numero, client);
  return client;
}

// Iniciar cliente y enviar QR
app.get('/qr/:numero', async (req, res) => {
  const numero = req.params.numero;
  try {
    getOrCreateClient(numero);
    res.json({ message: `Cliente para ${numero} inicializado.` });
  } catch (err) {
    console.error(`❌ Error creando cliente para ${numero}:`, err);
    res.status(500).json({ error: 'Error iniciando cliente de WhatsApp' });
  }
});

// Stream QR vía Server-Sent Events (SSE)
app.get('/qr-stream/:numero', (req, res) => {
  const numero = req.params.numero;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (!qrSubscribers[numero]) {
    qrSubscribers[numero] = [];
  }

  qrSubscribers[numero].push(res);

  req.on('close', () => {
    qrSubscribers[numero] = qrSubscribers[numero].filter(sub => sub !== res);
  });
});

// Enviar QR a clientes conectados vía SSE
function sendQRToClients(numero, qrDataUrl) {
  if (qrSubscribers[numero]) {
    qrSubscribers[numero].forEach(res =>
      res.write(`data: ${qrDataUrl}\n\n`)
    );
  }
}

// Enviar señal de que el cliente está listo
function sendReadySignal(numero) {
  if (qrSubscribers[numero]) {
    qrSubscribers[numero].forEach(res =>
      res.write(`data: ready\n\n`)
    );
  }
}

// Enviar mensajes de texto personalizados
app.post('/send-text', async (req, res) => {
  try {
    const { dataText, messageTemplate, senderNumber } = req.body;

    if (!senderNumber) {
      return res.status(400).json({ error: 'Falta senderNumber en la solicitud' });
    }

    const client = getOrCreateClient(senderNumber);

    const lines = dataText.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];

    for (const line of lines) {
      const [numberRaw, nombre] = line.split(',');
      const number = numberRaw.trim();
      const message = messageTemplate.replace('{nombre}', nombre?.trim() || 'amigo');
      const chatId = number + '@c.us';

      await client.sendMessage(chatId, message);
      results.push({ number, status: 'enviado' });
    }

    res.json(results);
  } catch (err) {
    console.error('❌ Error enviando mensajes:', err);
    res.status(500).json({ error: 'Error enviando mensajes' });
  }
});

// Enviar imagen con caption personalizado
app.post('/send-image-form', upload.single('imagen'), async (req, res) => {
  const fsPromises = fs.promises;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ninguna imagen' });
    }

    const { number, caption, senderNumber } = req.body;

    if (!senderNumber) {
      return res.status(400).json({ error: 'Falta senderNumber en la solicitud' });
    }

    const client = getOrCreateClient(senderNumber);

    const originalPath = req.file.path;
    const optimizedPath = originalPath + '-optimized.jpg';

    await sharp(originalPath)
      .resize({ width: 1024 })
      .jpeg({ quality: 80 })
      .toFile(optimizedPath);

    const media = MessageMedia.fromFilePath(optimizedPath);
    const chatId = number.trim() + '@c.us';

    await client.sendMessage(chatId, media, { caption });

    await fsPromises.unlink(originalPath);
    await fsPromises.unlink(optimizedPath);

    res.json({ number, status: 'imagen enviada' });
  } catch (err) {
    console.error('❌ Error enviando imagen:', err);

    if (req.file && req.file.path) {
      try { await fs.promises.unlink(req.file.path); } catch {}
      try { await fs.promises.unlink(req.file.path + '-optimized.jpg'); } catch {}
    }

    res.status(500).json({ error: 'Error enviando imagen' });
  }
});
// Cerrar sesión
app.post('/logout', async (req, res) => {
  const numero = req.body.numero;
  if (!numero) {
    return res.status(400).json({ error: 'Falta el número de teléfono en la solicitud' });
  }

  try {
    const client = clients.get(numero);
    if (client) {
      await client.destroy();
      clients.delete(numero);
    }

    const sessionPath = path.join(authPath, `session-${numero}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`🧹 Sesión de ${numero} eliminada`);
    }

    res.json({ message: 'Sesión cerrada correctamente' });
  } catch (err) {
    console.error(`❌ Error cerrando sesión para ${numero}:`, err);
    res.status(500).json({ message: 'Error cerrando sesión' });
  }
});



app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});
