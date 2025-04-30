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
const qrSubscribers = {}; // { numero: [res1, res2, ...] }
const authPath = './.wwebjs_auth';
const upload = multer({ dest: 'uploads/' });

// Sistema de seguimiento de mensajes
const messageCounts = new Map(); // { numero: { hourly: {timestamp: count}, daily: count, lastReset: Date } }

// Control de tiempo de escaneo de QR
const qrTimeouts = new Map(); // { numero: timeoutId }
const QR_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutos para escanear el QR

// Límites de envío
const HOURLY_LIMIT = 300;
const DAILY_LIMIT = 2000;
const MIN_DELAY_MS = 2000; // 2 segundos
const MAX_DELAY_MS = 5000; // 5 segundos

// Configurar temporizador para limpiar todas las sesiones cada 24 horas
const SESSION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 horas

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Limpiar directorios de uploads al inicio
cleanUploadsDirectory();

// Iniciar el temporizador de limpieza de sesiones
setInterval(cleanAllSessions, SESSION_CLEANUP_INTERVAL_MS);

// Función para limpiar directorio de uploads
function cleanUploadsDirectory() {
  const uploadsDir = path.join(__dirname, 'uploads');
  
  if (fs.existsSync(uploadsDir)) {
    try {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(uploadsDir, file));
        } catch (err) {
          console.error(`Error eliminando archivo ${file}:`, err);
        }
      }
      console.log('🧹 Directorio de uploads limpiado');
    } catch (err) {
      console.error('Error al limpiar directorio de uploads:', err);
    }
  } else {
    fs.mkdirSync(uploadsDir);
    console.log('📁 Directorio de uploads creado');
  }
}

// Función para limpiar todas las sesiones
async function cleanAllSessions() {
  console.log('🕒 Iniciando limpieza programada de todas las sesiones...');
  
  // Primero cerrar todos los clientes activos
  for (const [numero, client] of clients.entries()) {
    try {
      console.log(`🔌 Cerrando cliente para ${numero}`);
      await client.destroy();
      clients.delete(numero);
    } catch (err) {
      console.error(`Error cerrando cliente ${numero}:`, err);
    }
  }

  // Limpiar estadísticas de mensajes
  messageCounts.clear();
  
  // Borrar temporizadores de QR
  for (const [numero, timeoutId] of qrTimeouts.entries()) {
    clearTimeout(timeoutId);
    qrTimeouts.delete(numero);
  }

  // Eliminar todas las carpetas de sesión
  if (fs.existsSync(authPath)) {
    try {
      const sessions = fs.readdirSync(authPath);
      for (const session of sessions) {
        if (session.startsWith('session-')) {
          const sessionPath = path.join(authPath, session);
          fs.rmSync(sessionPath, { recursive: true, force: true });
          console.log(`🧹 Sesión ${session} eliminada`);
        }
      }
      console.log('✨ Limpieza programada completada');
    } catch (err) {
      console.error('Error al limpiar sesiones:', err);
    }
  }
  
  // Limpiar también el directorio de uploads
  cleanUploadsDirectory();
}

// Función para eliminar una sesión específica
async function cleanSession(numero) {
  console.log(`🗑️ Eliminando sesión para ${numero}`);
  
  try {
    // Detener temporizador de QR si existe
    if (qrTimeouts.has(numero)) {
      clearTimeout(qrTimeouts.get(numero));
      qrTimeouts.delete(numero);
    }
    
    // Cerrar y destruir cliente si existe
    const client = clients.get(numero);
    if (client) {
      await client.destroy();
      clients.delete(numero);
    }
    
    // Eliminar estadísticas de mensajes
    messageCounts.delete(numero);
    
    // Eliminar carpeta de sesión
const sessionPath = path.join(authPath, `session-${numero}`);
if (fs.existsSync(sessionPath)) {
  fs.rmSync(sessionPath, { recursive: true, force: true });
  console.log(`🧹 Sesión de ${numero} eliminada`);
}
    
    // Notificar a los suscriptores de QR que la sesión ha sido eliminada
    if (qrSubscribers[numero]) {
      qrSubscribers[numero].forEach(res => {
        try {
          res.write(`data: session_expired\n\n`);
          res.end();
        } catch (err) {
          console.error(`Error notificando expiración a suscriptor de ${numero}:`, err);
        }
      });
      delete qrSubscribers[numero];
    }
    
    return true;
  } catch (err) {
    console.error(`❌ Error eliminando sesión para ${numero}:`, err);
    return false;
  }
}

// Configurar temporizador para eliminar una sesión si el QR no se escanea
function setQRTimeout(numero) {
  // Limpiar temporizador existente si hay uno
  if (qrTimeouts.has(numero)) {
    clearTimeout(qrTimeouts.get(numero));
  }
  
  // Establecer nuevo temporizador
  const timeoutId = setTimeout(async () => {
    console.log(`⏰ Tiempo de espera de QR expirado para ${numero}`);
    await cleanSession(numero);
  }, QR_TIMEOUT_MS);
  
  qrTimeouts.set(numero, timeoutId);
}

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
      clientId: `${numero}`,
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
    
    // Establecer temporizador para este QR
    setQRTimeout(numero);
    
    sendQRToClients(numero, qrDataUrl);
  });

  client.on('ready', () => {
    console.log(`✅ Cliente ${numero} listo`);
    
    // Limpiar temporizador de QR cuando se autentica correctamente
    if (qrTimeouts.has(numero)) {
      clearTimeout(qrTimeouts.get(numero));
      qrTimeouts.delete(numero);
    }
    
    sendReadySignal(numero);
  });

  client.on('auth_failure', msg => {
    console.error(`❌ Fallo de autenticación para ${numero}:`, msg);
    // Limpiar la sesión en caso de fallo de autenticación
    cleanSession(numero);
  });

  client.on('disconnected', async (reason) => {
    console.log(`🔌 Cliente ${numero} desconectado:`, reason);
    await cleanSession(numero);
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
  let originalPath = null;
  let optimizedPath = null;

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

    originalPath = req.file.path;
    optimizedPath = originalPath + '-optimized.jpg';

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

    // Limpiar archivos después del envío
    if (originalPath && fs.existsSync(originalPath)) {
      await fsPromises.unlink(originalPath);
    }
    
    if (optimizedPath && fs.existsSync(optimizedPath)) {
      await fsPromises.unlink(optimizedPath);
    }

    res.json({ number, status: 'imagen enviada' });
  } catch (err) {
    console.error('❌ Error enviando imagen:', err);

    // Asegurar la limpieza de archivos incluso en caso de error
    try {
      if (originalPath && fs.existsSync(originalPath)) {
        await fs.promises.unlink(originalPath);
      }
    } catch (unlinkErr) {
      console.error('Error eliminando archivo original:', unlinkErr);
    }
    
    try {
      if (optimizedPath && fs.existsSync(optimizedPath)) {
        await fs.promises.unlink(optimizedPath);
      }
    } catch (unlinkErr) {
      console.error('Error eliminando archivo optimizado:', unlinkErr);
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
    const success = await cleanSession(numero);
    if (success) {
      res.json({ message: 'Sesión cerrada correctamente' });
    } else {
      res.status(500).json({ message: 'Error cerrando sesión' });
    }
  } catch (err) {
    console.error(`❌ Error cerrando sesión para ${numero}:`, err);
    res.status(500).json({ message: 'Error cerrando sesión' });
  }
});

// Nuevo endpoint para forzar limpieza de todas las sesiones
app.post('/clean-all-sessions', async (req, res) => {
  try {
    await cleanAllSessions();
    res.json({ message: 'Todas las sesiones han sido limpiadas correctamente' });
  } catch (err) {
    console.error('❌ Error limpiando todas las sesiones:', err);
    res.status(500).json({ error: 'Error limpiando sesiones' });
  }
});

// Nuevo endpoint para configurar el tiempo de espera de QR
app.post('/set-qr-timeout', (req, res) => {
  const { timeoutMinutes } = req.body;
  
  if (!timeoutMinutes || isNaN(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
    return res.status(400).json({ error: 'El tiempo de espera debe ser entre 1 y 60 minutos' });
  }
  
  const oldTimeout = QR_TIMEOUT_MS / (60 * 1000);
  QR_TIMEOUT_MS = timeoutMinutes * 60 * 1000;
  
  console.log(`⏱️ Tiempo de espera de QR actualizado de ${oldTimeout} a ${timeoutMinutes} minutos`);
  res.json({ message: `Tiempo de espera actualizado a ${timeoutMinutes} minutos` });
});

app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});