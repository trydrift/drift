/**
 * The navigation still has to know which link is active, and still has to route.
 *
 * react-router-dom 6 removed `NavLink`'s `activeClassName` and `exact`, removed
 * `Switch`, `Redirect` and `withRouter`, and made `<Route>` render an `element`.
 * Every one of those is a compile error, which means a migration can satisfy
 * `tsc` by deleting the props it cannot typecheck — dropping `activeClassName`
 * is one keystroke and the build goes green.
 *
 * What goes with it is invisible: the active navigation item stops being
 * highlighted. Nothing throws, every test that only mounts the component still
 * passes, and the product ships a sidebar where nothing indicates where you
 * are. `exact`/`end` is the same story in the other direction — without it the
 * root link matches every child route and two items light up at once.
 *
 * So this renders the real components inside a real router and asserts on the
 * rendered DOM: which link carries the active class at a given location, and
 * that the routed content follows the location.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { VerticalNav, VerticalNavItem } from '../src/components/modules/VerticalNav/VerticalNav';

describe('navigation after the react-router-dom 6 upgrade', () => {
	it('marks the item matching the current location as active, and only that one', () => {
		const { container } = render(
			<MemoryRouter initialEntries={['/settings']}>
				<VerticalNav>
					<VerticalNavItem type="navlink" routeTo="/overview" navLinkActiveClassName="is-current">
						Overview
					</VerticalNavItem>
					<VerticalNavItem type="navlink" routeTo="/settings" navLinkActiveClassName="is-current">
						Settings
					</VerticalNavItem>
				</VerticalNav>
			</MemoryRouter>
		);

		const active = container.querySelectorAll('.is-current');
		expect(active.length).toBe(1);
		expect(active[0].textContent).toContain('Settings');

		// The other link must exist and must not be marked active: a migration
		// that dropped the active class entirely would also produce zero
		// matches above, and one that always applies it would produce two.
		expect(screen.getByText('Overview').closest('a')).toBeTruthy();
		expect(screen.getByText('Overview').closest('a')!.className).not.toContain('is-current');
	});

	it('follows the location when it changes', () => {
		const { container } = render(
			<MemoryRouter initialEntries={['/overview']}>
				<VerticalNav>
					<VerticalNavItem type="navlink" routeTo="/overview" navLinkActiveClassName="is-current">
						Overview
					</VerticalNavItem>
					<VerticalNavItem type="navlink" routeTo="/settings" navLinkActiveClassName="is-current">
						Settings
					</VerticalNavItem>
				</VerticalNav>
				<Routes>
					<Route path="/overview" element={<div>overview content</div>} />
					<Route path="/settings" element={<div>settings content</div>} />
				</Routes>
			</MemoryRouter>
		);

		expect(screen.getByText('overview content')).toBeTruthy();
		const active = container.querySelectorAll('.is-current');
		expect(active.length).toBe(1);
		expect(active[0].textContent).toContain('Overview');
	});
});
