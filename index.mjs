import express from "express";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/static", express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Faltan SUPABASE_URL o SUPABASE_*KEY en el entorno");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function getSlug(host) {
  const parts = (host || "").split(":")[0].split(".");
  if (parts.length < 3) return null; // dominio raíz
  return parts[0]; // primer subdominio = slug
}

app.use(async (req, res, next) => {
  if (req.path === "/health") return next();

  const slug = getSlug(req.headers.host);
  if (!slug) return res.send("Landing Agendador"); // raíz

  const { data: org, error } = await supabase
    .from("organizations")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (error) return res.status(500).send("Error DB");
  if (!org) return res.status(404).send("No existe esa organización");

  req.org = org;
  next();
});

app.get("/", (req, res) => {
  res.render("tenant", { org: req.org, cdn: "/static" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () =>
  console.log(`Agendador corriendo en http://localhost:${PORT}`)
);
