import { Board } from '@/components/canvas/Board';

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Board boardId={id} />;
}
