const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode'); // Usamos qrcode para imagen base64
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Variables globales para SSE
let currentQR = null;
let qrClients = [];

app.get('/qr-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (currentQR) {
    res.write(`data: ${currentQR}\n\n`);
  }

  qrClients.push(res);

  req.on('close', () => {
    qrClients = qrClients.filter(client => client !== res);
  });
});

// Cliente de WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

client.on('qr', async (qr) => {
  console.log('Escanea el QR con tu celular');
  try {
    const qrDataURL = await qrcode.toDataURL(qr);
    currentQR = qrDataURL;
    qrClients.forEach(client => client.write(`data: ${qrDataURL}\n\n`));
  } catch (error) {
    console.error('❌ Error al generar QR:', error.message);
  }
});

client.on('ready', () => {
  console.log('✅ WhatsApp listo para enviar mensajes');
  qrClients.forEach(client => client.write(`data: ready\n\n`));
  currentQR = null;
});

client.initialize();

// Rutas
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/send-text', async (req, res) => {
  const { dataText, messageTemplate } = req.body;
  if (!dataText || !messageTemplate) {
    return res.status(400).send({ status: 'error', message: 'Faltan datos' });
  }

  const lines = dataText.split('\n').map(l => l.trim()).filter(l => l);
  const resultados = [];

  for (const line of lines) {
    const [numberRaw, nombre] = line.split(',');
    const number = numberRaw.trim();
    const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
    const mensajePersonalizado = messageTemplate.replace('{nombre}', nombre || 'amigo');

    try {
      await client.sendMessage(chatId, mensajePersonalizado);
      resultados.push({ number, status: 'enviado' });
    } catch (err) {
      resultados.push({ number, status: 'error', error: err.message });
    }
  }

  res.send({ status: 'ok', resultados });
});

// Configuración de subida de imagen
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'imagenes/');
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const filename = `${Date.now()}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({ storage });

app.post('/send-image-form', upload.single('imagen'), async (req, res) => {
  const { number, caption } = req.body;
  const filePath = path.resolve(req.file.path);
  const chatId = number.includes('@c.us') ? number : `${number}@c.us`;

  try {
    const media = MessageMedia.fromFilePath(filePath);
    await client.sendMessage(chatId, media, { caption });
    res.send({ status: 'success', message: 'Imagen enviada' });
  } catch (error) {
    console.error('❌ Error al enviar imagen:', error.message);
    res.status(500).send({ status: 'error', error: error.message });
  }
});

const SESSION_DIR = path.join(__dirname, '.wwebjs_auth'); // ruta correcta a la carpeta de sesión

app.post('/logout', async (req, res) => {
  try {
    await client.destroy(); // cierra sesión activa
    fs.rmSync(SESSION_DIR, { recursive: true, force: true }); // elimina carpeta de sesión

    // 🔁 Reinicia el cliente
    client.initialize();

    res.send({ status: 'ok', message: 'Sesión cerrada correctamente' });
  } catch (error) {
    console.error('❌ Error al cerrar sesión:', error.message);
    res.status(500).send({ status: 'error', message: error.message });
  }
});


// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
