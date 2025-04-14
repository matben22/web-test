const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const pdf = require('pdf-parse');

const app = express();
const port = process.env.PORT || 3000;

// Para poder interpretar JSON en peticiones
app.use(express.json());

// Servir archivos estáticos desde la carpeta actual (donde está index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Configurar la base de datos SQLite
const db = new sqlite3.Database('./questions.db', (err) => {
  if (err) {
    console.error("Error al abrir la base de datos", err);
  } else {
    console.log("Base de datos abierta correctamente.");
    db.run(
      `CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        theme TEXT,
        question TEXT,
        options TEXT,
        correct INTEGER,
        error_count INTEGER DEFAULT 0
      )`,
      (err) => {
        if (err) console.error("Error al crear la tabla", err);
      }
    );
  }
});

// ----------------------------------------------------------------------
// ENDPOINTS ACTUALES (API de preguntas, borrar tema, etc.)
// ----------------------------------------------------------------------

// Crear nueva pregunta
app.post('/api/questions', (req, res) => {
  const { theme, question, options, correct } = req.body;
  if (!theme || !question || !Array.isArray(options) || correct == null) {
    return res.status(400).json({ error: "Faltan datos requeridos." });
  }
  const optionsJSON = JSON.stringify(options);
  db.run(
    `INSERT INTO questions (theme, question, options, correct)
     VALUES (?, ?, ?, ?)`,
    [theme, question, optionsJSON, correct],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Error en la base de datos." });
      }
      res.json({ id: this.lastID });
    }
  );
});

// Obtener preguntas (opcionalmente por tema o por texto parcial)
app.get('/api/questions', (req, res) => {
  const { theme, search } = req.query;
  let query = "SELECT * FROM questions";
  const params = [];

  // Filtrado por tema
  if (theme) {
    query += " WHERE theme = ?";
    params.push(theme);
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Error en la base de datos." });
    }
    // Parsear options
    rows = rows.map(row => {
      try {
        return { ...row, options: JSON.parse(row.options) };
      } catch {
        return { ...row, options: [] };
      }
    });

    // Filtrado adicional por 'search' (texto parcial en la pregunta)
    if (search) {
      const lowerSearch = search.toLowerCase();
      rows = rows.filter((q) =>
        q.question.toLowerCase().includes(lowerSearch)
      );
    }

    res.json(rows);
  });
});

// Borrar un tema completo
app.delete('/api/themes', (req, res) => {
  const theme = req.query.theme;
  if (!theme) {
    return res.status(400).json({ error: 'El parámetro "theme" es requerido.' });
  }

  db.run('DELETE FROM questions WHERE theme = ?', [theme], function(err) {
    if (err) {
      console.error("Error al borrar el tema:", err);
      return res.status(500).json({ error: 'Error al borrar el tema.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'No se encontró el tema a borrar.' });
    }
    res.json({ message: `Tema "${theme}" borrado correctamente.` });
  });
});

// Incrementar el contador de errores de una pregunta
app.patch('/api/questions/:id/error', (req, res) => {
  const questionId = req.params.id;
  db.run(
    'UPDATE questions SET error_count = error_count + 1 WHERE id = ?',
    [questionId],
    function(err) {
      if (err) {
        console.error("Error al actualizar error_count:", err);
        return res.status(500).json({ error: 'Error al actualizar error_count.' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Pregunta no encontrada.' });
      }
      console.log(`Pregunta ${questionId}: error_count incrementado.`);
      res.json({ message: 'Contador de error incrementado correctamente.' });
    }
  );
});

// Borrar pregunta individual
app.delete('/api/questions/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM questions WHERE id = ?', [id], function(err) {
    if (err) {
      console.error("Error al borrar pregunta:", err);
      return res.status(500).json({ error: 'Error al borrar la pregunta.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Pregunta no encontrada.' });
    }
    res.json({ message: 'Pregunta borrada correctamente.' });
  });
});

// Actualizar pregunta por ID
app.put('/api/questions/:id', (req, res) => {
  const id = req.params.id;
  const { theme, question, options, correct } = req.body;

  console.log(`PUT /api/questions/${id} con datos:`, req.body);

  if (!theme || !question || !Array.isArray(options) || correct == null) {
    console.error("Error de validación en PUT:", { theme, question, options, correct });
    return res.status(400).json({ error: "Faltan datos requeridos." });
  }

  const optionsJSON = JSON.stringify(options);
  db.run(
    `UPDATE questions
       SET theme = ?, question = ?, options = ?, correct = ?
       WHERE id = ?`,
    [theme, question, optionsJSON, correct, id],
    function(err) {
      if (err) {
        console.error(`Error al actualizar la pregunta con id ${id}:`, err);
        return res.status(500).json({ error: 'Error al actualizar pregunta.' });
      }
      if (this.changes === 0) {
        console.error(`No se encontró ninguna pregunta con id ${id}`);
        return res.status(404).json({ error: 'Pregunta no encontrada.' });
      }
      console.log(`Pregunta con id ${id} actualizada correctamente.`);
      return res.json({ message: 'Pregunta actualizada correctamente.' });
    }
  );
});

// ----------------------------------------------------------------------
// NUEVO: ENDPOINT PARA SUBIR PDF CON PREGUNTAS
// ----------------------------------------------------------------------

// Configuramos 'multer' para recibir el archivo en memoria
const upload = multer({ storage: multer.memoryStorage() });

// Endpoint que recibe el PDF y extrae preguntas marcadas con asteriscos
app.post('/api/pdf', upload.single('pdfFile'), async (req, res) => {
  try {
    const theme = req.body.theme;
    if (!theme) {
      return res.status(400).json({ error: 'Falta el nombre del tema.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo PDF.' });
    }

    // Extraemos el texto del PDF con pdf-parse
    const data = await pdf(req.file.buffer);
    const rawText = data.text;

    // Parseamos las preguntas con la función que busca asteriscos
    const questions = parseQuestionsWithMarker(rawText);
    if (!questions.length) {
      return res.status(400).json({ error: 'No se encontraron preguntas en el PDF.' });
    }

    let insertCount = 0;
    for (const q of questions) {
      const optionsJSON = JSON.stringify(q.options);
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO questions (theme, question, options, correct)
           VALUES (?, ?, ?, ?)`,
          [theme, q.question, optionsJSON, q.correct],
          function (err) {
            if (err) return reject(err);
            insertCount++;
            resolve();
          }
        );
      });
    }

    res.json({ message: `Se añadieron ${insertCount} preguntas al tema "${theme}".` });

  } catch (err) {
    console.error("Error al procesar el PDF:", err);
    res.status(500).json({ error: 'Error al procesar el PDF.' });
  }
});

// Función de parseo de preguntas con asteriscos
function parseQuestionsWithMarker(text) {
  // Separa el PDF en líneas
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const questions = [];
  let currentQuestion = null;
  let answersBuffer = [];

  // Regex para "N. Título de la pregunta"
  const questionRegex = /^(\d+)\.\s*(.*)$/;
  // Regex para "a) texto", "b) texto", etc. (acepta mayúsculas)
  const answerRegex = /^[abcdABCD]\)\s*(.*)$/;

  for (const line of lines) {
    // ¿Línea que define nueva pregunta?
    const qMatch = line.match(questionRegex);
    if (qMatch) {
      // Si había una pregunta en curso, la guardamos
      if (currentQuestion && answersBuffer.length) {
        questions.push({
          question: currentQuestion,
          options: answersBuffer.map(a => a.text),
          correct: answersBuffer.findIndex(a => a.isCorrect)
        });
      }
      // Nueva pregunta
      currentQuestion = qMatch[2]; // texto de la pregunta
      answersBuffer = [];
      continue;
    }

    // ¿Línea que define una respuesta?
    const aMatch = line.match(answerRegex);
    if (aMatch && currentQuestion) {
      let ansText = aMatch[1];
      let isCorrect = false;

      // Si termina con uno o varios asteriscos => es la correcta
      if (/\*+$/.test(ansText)) {
        isCorrect = true;
        ansText = ansText.replace(/\*+$/, '').trim();
      }
      answersBuffer.push({
        text: ansText,
        isCorrect
      });
    }
  }

  // Guardar la última pregunta si queda pendiente
  if (currentQuestion && answersBuffer.length) {
    questions.push({
      question: currentQuestion,
      options: answersBuffer.map(a => a.text),
      correct: answersBuffer.findIndex(a => a.isCorrect)
    });
  }

  // Filtramos preguntas que no tengan 4 respuestas o sin respuesta correcta
  return questions.filter(q =>
    q.options.length === 4 &&
    q.correct >= 0 &&
    q.correct < 4
  );
}

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});
