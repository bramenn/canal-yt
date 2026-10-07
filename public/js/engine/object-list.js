// Objetos animados disponibles (id → para qué sirve). Solo datos: lo usan el motor, la interfaz y los prompts de Claude Code.
export const OBJECT_INFO = {
  phone: 'móvil con notificación', laptopcode: 'portátil escribiendo código', code: 'símbolo </>', terminal: 'ventana de terminal',
  database: 'base de datos', cloudup: 'subir a la nube', wifi: 'wifi / conexión', battery: 'batería cargando', plug: 'enchufe / consumo eléctrico',
  gear: 'engranajes / configuración', robot: 'robot / agente', brain: 'cerebro / razonamiento', sparkles: 'destellos / "magia" IA', lightbulb: 'idea / bombilla',
  card: 'tarjeta de crédito / suscripción', wallet: 'cartera / gasto', piggy: 'hucha / ahorro', coins: 'monedas', token: 'ficha de token', receipt: 'factura / ticket',
  cart: 'carrito / comprar', chartup: 'gráfica que sube', chartdown: 'gráfica que baja', trophy: 'trofeo / ganador', crown: 'corona / el mejor', scale: 'balanza / comparar',
  hourglass: 'reloj de arena / esperar', stopwatch: 'cronómetro / medir tiempo', calendar: 'calendario / fecha', snail: 'caracol / lento', rocket: 'cohete / rápido, lanzamiento',
  fire: 'fuego / lo más caliente', speed: 'velocímetro / rendimiento', thumbup: 'pulgar arriba', thumbdown: 'pulgar abajo', target: 'diana / acertar',
  warning: 'advertencia / ojo', lock: 'candado / privacidad', key: 'llave / API key', shield: 'escudo / seguridad', bug: 'bug / error', magnet: 'imán / atrae',
  puzzle: 'puzzle / encajar piezas', flask: 'matraz / experimento', book: 'libro / documentación', globe: 'mundo / internet', house: 'casa / IA en local',
  chat: 'conversación', mic: 'micrófono / voz', headphones: 'auriculares / audio', camera: 'cámara grabando', image: 'imagen generada', video: 'vídeo',
  mail: 'correo', eye: 'ojo / visión', search: 'lupa / buscar', megaphone: 'megáfono / anuncio', dice: 'dado / azar', download: 'descargar', upload: 'subir',
};
export const OBJECT_NAMES = Object.keys(OBJECT_INFO);
