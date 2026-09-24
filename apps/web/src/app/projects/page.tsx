import { ProjectsPage } from "@/components/projects-page";
export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const params = await searchParams;
  return <ProjectsPage initialSurface={params.view === "list" ? "projects" : "new"} />;
}
