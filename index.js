const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const cors = require('cors');
let client = null; // fuera de la función
const authPath = './.wwebjs_auth'; // o reemplaza con tu ruta personalizada
const sharp = require('sharp');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

let qrSubscribers = [];

app.get('/qr-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  qrSubscribers.push(res);

  req.on('close', () => {
    qrSubscribers = qrSubscribers.filter(sub => sub !== res);
  });
});

function sendQRToClients(qrDataUrl) {
  qrSubscribers.forEach(sub => sub.write(`data: ${qrDataUrl}\n\n`));
}

function sendReadySignal() {
  qrSubscribers.forEach(sub => sub.write(`data: ready\n\n`));
}

function startSock() {
  sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, isNewLogin } = update;

    if (qr) {
      currentQR = qr;
      const qrDataUrl = qrImage.imageSync(qr, { type: 'png' });
      const base64Image = `data:image/png;base64,${qrDataUrl.toString('base64')}`;
      clients.forEach(res => res.write(`data: ${base64Image}\n\n`));
    }

    if (connection === 'open') {
      clients.forEach(res => res.write(`data: ready\n\n`));
      clients.length = 0;
    }

    if (connection === 'close') {
      const shouldReconnect = (update.lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        startSock();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}


// Crear cliente de WhatsApp
function createClient() {
  client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox']
  }
});

client.on('qr', async (qr) => {
  const qrDataUrl = await qrcode.toDataURL(qr);
  sendQRToClients(qrDataUrl);
});

client.on('ready', () => {
  console.log('✅ Cliente listo');
  sendReadySignal();
});

client.on('auth_failure', msg => {
  console.error('❌ Fallo de autenticación:', msg);
});

client.on('disconnected', async (reason) => {
  console.log('🔌 Cliente desconectado:', reason);
  
  // Cerramos la instancia del cliente cuando se desconecte
  await client.destroy();
  
  // Vuelve a crear una nueva instancia del cliente
  createClient();
});


client.initialize();
}
createClient();
// Enviar mensajes de texto personalizados
app.post('/send-text', async (req, res) => {
  try {
    const { dataText, messageTemplate } = req.body;
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
    console.error(err);
    res.status(500).json({ error: 'Error enviando mensajes' });
  }
});

// Enviar imagen con caption personalizado y compresión
app.post('/send-image-form', upload.single('imagen'), async (req, res) => {
  const fsPromises = fs.promises;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ninguna imagen' });
    }

    const { number, caption } = req.body;
    const originalPath = req.file.path;
    const optimizedPath = originalPath + '-optimized.jpg';

    // Optimizar/comprimir imagen usando sharp
    await sharp(originalPath)
      .resize({ width: 1024 }) // opcional: reducir tamaño si es muy grande
      .jpeg({ quality: 80 }) // cambiar a .png() si prefieres PNG
      .toFile(optimizedPath);

    // Crear media y enviar
    const media = MessageMedia.fromFilePath(optimizedPath);
    const chatId = number.trim() + '@c.us';

    await client.sendMessage(chatId, media, { caption });

    // Borrar imágenes (original y optimizada)
    await fsPromises.unlink(originalPath);
    await fsPromises.unlink(optimizedPath);

    res.json({ number, status: 'imagen enviada' });
  } catch (err) {
    console.error('❌ Error enviando imagen:', err);

    // Cleanup en caso de error
    if (req.file && req.file.path) {
      try { await fsPromises.unlink(req.file.path); } catch {}
      try { await fsPromises.unlink(req.file.path + '-optimized.jpg'); } catch {}
    }

    res.status(500).json({ error: 'Error enviando imagen' });
  }
});

// Cerrar sesión
app.post('/logout', async (req, res) => {
  try {
    if (client) {
      await client.destroy();
      client = null;
    }

 // Eliminar carpeta de sesión
 if (fs.existsSync(authPath)) {
  fs.rmSync(authPath, { recursive: true, force: true });
  console.log('🧹 Carpeta de sesión eliminada');
}

    createClient();
    res.json({ message: 'Sesión cerrada correctamente' });
  } catch (err) {
    console.error('❌ Error cerrando sesión:', err);
    res.status(500).json({ message: 'Error cerrando sesión' });
  }
});


app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});
