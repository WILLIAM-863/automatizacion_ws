const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const app = express();
const path = require('path');
const multer = require('multer');
const fs = require('fs');



// Esto sirve la carpeta "public" con tu HTML
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());

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

client.on('qr', (qr) => {
  console.log('Escanea el QR con tu celular');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp listo para enviar mensajes');
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


app.post('/send-image', async (req, res) => {
  const { number, imagePath, caption } = req.body;
  const chatId = number.includes('@c.us') ? number : `${number}@c.us`;

  try {
    const media = MessageMedia.fromFilePath(imagePath);
    await client.sendMessage(chatId, media, { caption });

    // Eliminar la imagen una vez enviada
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error('⚠️ No se pudo eliminar la imagen:', err.message);
      } else {
        console.log('🧹 Imagen eliminada:', filePath);
      }
    });
    
    res.send({ status: 'success', message: 'Imagen enviada y eliminada' });
    
  } catch (error) {
    res.status(500).send({ status: 'error', error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

client.initialize();
app.listen(3000, () => console.log('🚀 Servidor corriendo en http://localhost:3000'));



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


app.use(express.static(path.join(__dirname, 'public')));

app.post('/send-image-form', upload.single('imagen'), async (req, res) => {
  const { number, caption } = req.body;
  const filePath = path.resolve(req.file.path); // ruta absoluta por seguridad

  console.log('➡️ Archivo recibido:', req.file);

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
