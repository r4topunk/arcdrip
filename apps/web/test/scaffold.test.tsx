import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HomePage from '@/app/page';

// Scaffold-only: keeps `vitest run` meaningful before the real page suites exist.
describe('scaffold', () => {
  it('renders the home page heading', () => {
    render(<HomePage />);
    expect(screen.getByRole('heading', { name: 'ArcDrip' })).toBeInTheDocument();
  });
});
