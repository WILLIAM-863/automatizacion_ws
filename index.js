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

// Sistema de seguimiento de mensajes
const messageCounts = new Map(); // { numero: { hourly: {timestamp: count}, daily: count, lastReset: Date } }

// Límites de envío
const HOURLY_LIMIT = 300;
const DAILY_LIMIT = 2000;
const MIN_DELAY_MS = 2000; // 2 segundos
const MAX_DELAY_MS = 5000; // 5 segundos

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Función para obtener un retraso aleatorio entre MIN_DELAY_MS y MAX_DELAY_MS
function getRandomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1) + MIN_DELAY_MS);
}

// Función para verificar y actualizar los contadores de mensajes
function trackMessage(numero) {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDate = now.toDateString();
  
  if (!messageCounts.has(numero)) {
    messageCounts.set(numero, {
      hourly: { [currentHour]: 1 },
      daily: 1,
      lastReset: now
    });
    return { hourlyOk: true, dailyOk: true };
  }
  
  const stats = messageCounts.get(numero);
  
  // Comprobar si necesitamos resetear el contador diario (después de la medianoche)
  if (stats.lastReset.toDateString() !== currentDate) {
    stats.daily = 1;
    stats.hourly = { [currentHour]: 1 };
    stats.lastReset = now;
    return { hourlyOk: true, dailyOk: true };
  }
  
  // Actualizar contador horario
  if (!stats.hourly[currentHour]) {
    stats.hourly[currentHour] = 1;
  } else {
    stats.hourly[currentHour]++;
  }
  
  // Actualizar contador diario
  stats.daily++;
  
  // Verificar límites
  const hourlyOk = stats.hourly[currentHour] <= HOURLY_LIMIT;
  const dailyOk = stats.daily <= DAILY_LIMIT;
  
  return { hourlyOk, dailyOk };
}

// Obtener estadísticas de envío de mensajes
function getMessageStats(numero) {
  if (!messageCounts.has(numero)) {
    return { hourly: 0, daily: 0, hourlyLimit: HOURLY_LIMIT, dailyLimit: DAILY_LIMIT };
  }
  
  const stats = messageCounts.get(numero);
  const currentHour = new Date().getHours();
  const hourlyCount = stats.hourly[currentHour] || 0;
  
  return {
    hourly: hourlyCount,
    daily: stats.daily,
    hourlyLimit: HOURLY_LIMIT,
    dailyLimit: DAILY_LIMIT
  };
}

function getOrCreateClient(numero) {
  if (clients.has(numero)) {
    return clients.get(numero);
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `session-${numero}`,
      dataPath: './.wwebjs_auth'
    }),
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

// Nueva función para enviar mensaje con retraso y límites
async function sendMessageWithRateLimit(client, chatId, content, options = {}) {
  const senderNumber = client.info?.wid?.user;
  
  if (!senderNumber) {
    throw new Error('No se pudo determinar el número del remitente');
  }
  
  const { hourlyOk, dailyOk } = trackMessage(senderNumber);
  
  if (!hourlyOk) {
    throw new Error(`Límite horario de ${HOURLY_LIMIT} mensajes alcanzado`);
  }
  
  if (!dailyOk) {
    throw new Error(`Límite diario de ${DAILY_LIMIT} mensajes alcanzado`);
  }
  
  // Aplicar retraso aleatorio
  const delay = getRandomDelay();
  await new Promise(resolve => setTimeout(resolve, delay));
  
  // Enviar el mensaje
  return client.sendMessage(chatId, content, options);
}

app.get('/session-status/:numero', async (req, res) => {
  const numero = req.params.numero;

  try {
    const client = clients.get(numero);

    if (client) {
      const state = await client.getState();
      if (state === 'CONNECTED') {
        return res.json({ estado: 'ready' });
      } else {
        return res.json({ estado: 'starting', detalle: state });
      }
    }

    // Revisión si hay una sesión guardada
    const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${numero}`, 'session.json');

    if (fs.existsSync(sessionPath)) {
      return res.json({ estado: 'saved' }); // Hay sesión guardada pero cliente aún no se ha inicializado
    }

    return res.json({ estado: 'not_ready' });
  } catch (err) {
    console.error(`❌ Error verificando estado de sesión para ${numero}:`, err);
    res.status(500).json({ error: 'Error verificando estado de sesión' });
  }
});

// Nuevo endpoint para obtener estadísticas de mensajes
app.get('/message-stats/:numero', (req, res) => {
  const numero = req.params.numero;
  const stats = getMessageStats(numero);
  res.json(stats);
});

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

function sendQRToClients(numero, qrDataUrl) {
  if (qrSubscribers[numero]) {
    qrSubscribers[numero].forEach(res =>
      res.write(`data: ${qrDataUrl}\n\n`)
    );
  }
}

function sendReadySignal(numero) {
  if (qrSubscribers[numero]) {
    qrSubscribers[numero].forEach(res =>
      res.write(`data: ready\n\n`)
    );
  }
}

// Enviar mensajes de texto personalizados con límites
app.post('/send-text', async (req, res) => {
  try {
    const { dataText, messageTemplate, senderNumber } = req.body;

    if (!senderNumber) {
      return res.status(400).json({ error: 'Falta senderNumber en la solicitud' });
    }

    const client = getOrCreateClient(senderNumber);
    
    // Verificar estado antes de procesar
    const stats = getMessageStats(senderNumber);
    if (stats.hourly >= HOURLY_LIMIT) {
      return res.status(429).json({ 
        error: 'Límite horario excedido',
        stats
      });
    }
    
    if (stats.daily >= DAILY_LIMIT) {
      return res.status(429).json({ 
        error: 'Límite diario excedido',
        stats
      });
    }

    const lines = dataText.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];

    for (const line of lines) {
      try {
        const [numberRaw, nombre] = line.split(',');
        const number = numberRaw.trim();
        const message = messageTemplate.replace('{nombre}', nombre?.trim() || 'amigo');
        const chatId = number + '@c.us';

        // Verificar límites antes de cada envío
        const { hourlyOk, dailyOk } = trackMessage(senderNumber);
        
        if (!hourlyOk) {
          results.push({ number, status: 'error', message: `Límite horario de ${HOURLY_LIMIT} mensajes alcanzado` });
          continue;
        }
        
        if (!dailyOk) {
          results.push({ number, status: 'error', message: `Límite diario de ${DAILY_LIMIT} mensajes alcanzado` });
          break; // Salir del bucle si se alcanza el límite diario
        }

        // Aplicar retraso aleatorio
        const delay = getRandomDelay();
        await new Promise(resolve => setTimeout(resolve, delay));
        
        await client.sendMessage(chatId, message);
        results.push({ number, status: 'enviado' });
      } catch (err) {
        console.error(`Error enviando mensaje a línea '${line}':`, err);
        results.push({ number: line, status: 'error', message: err.message });
      }
    }

    res.json(results);
  } catch (err) {
    console.error('❌ Error enviando mensajes:', err);
    res.status(500).json({ error: 'Error enviando mensajes' });
  }
});

// Enviar imagen con caption personalizado y límites
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
    
    // Verificar límites antes de enviar
    const { hourlyOk, dailyOk } = trackMessage(senderNumber);
    
    if (!hourlyOk) {
      await fsPromises.unlink(req.file.path);
      return res.status(429).json({ 
        error: `Límite horario de ${HOURLY_LIMIT} mensajes alcanzado`,
        stats: getMessageStats(senderNumber)
      });
    }
    
    if (!dailyOk) {
      await fsPromises.unlink(req.file.path);
      return res.status(429).json({ 
        error: `Límite diario de ${DAILY_LIMIT} mensajes alcanzado`,
        stats: getMessageStats(senderNumber)
      });
    }

    const originalPath = req.file.path;
    const optimizedPath = originalPath + '-optimized.jpg';

    await sharp(originalPath)
      .resize({ width: 1024 })
      .jpeg({ quality: 80 })
      .toFile(optimizedPath);

    const media = MessageMedia.fromFilePath(optimizedPath);
    const chatId = number.trim() + '@c.us';

    // Aplicar retraso aleatorio
    const delay = getRandomDelay();
    await new Promise(resolve => setTimeout(resolve, delay));

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

    // Eliminar también las estadísticas de mensajes
    messageCounts.delete(numero);

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