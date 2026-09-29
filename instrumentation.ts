/** Runs once when the Next.js server boots: connect to MongoDB early so problems show up in the terminal immediately. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { dbConnect } = await import("./lib/mongodb");
  try {
    await dbConnect();
  } catch (e) {
    console.error(`\nMongoDB unavailable:\n${(e as Error).message}\n`);
  }
}
