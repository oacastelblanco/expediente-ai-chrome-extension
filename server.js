import app from "./backend/server.js";

const PORT = Number(process.env.PORT || 3001);

app.listen(PORT, () => {
  console.log(`Expediente AI backend activo en http://localhost:${PORT}`);
});
