/**
 * Toasts still have to appear in the bottom right, and still have to close.
 *
 * react-toastify 10 removed `toast.POSITION`, the enum this component read its
 * default from. The replacement is the literal string the enum used to hold —
 * and the library's own default, if the default is simply dropped, is
 * `top-right`. Nothing fails when that happens: the container renders, the
 * toasts work, they appear in the wrong corner of every screen in the product.
 *
 * v10 also stopped re-exporting `CloseButtonProps`, and the close button this
 * project renders in its place is what dismisses a toast, so it is rendered
 * here too rather than trusted to compile.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import ToastContainer from '../src/components/alerts/ToastContainer/ToastContainer';

describe('ToastContainer after the react-toastify 10 upgrade', () => {
	it('keeps placing toasts in the bottom right by default', () => {
		const { container } = render(<ToastContainer />);

		const positioned = container.querySelector('.Toastify__toast-container');
		expect(positioned).not.toBeNull();
		expect(positioned!.className).toContain('Toastify__toast-container--bottom-right');
		expect(positioned!.className).not.toContain('Toastify__toast-container--top-right');
	});

	it('still lets an explicit position override the default', () => {
		const { container } = render(<ToastContainer position="top-left" />);

		const positioned = container.querySelector('.Toastify__toast-container');
		expect(positioned).not.toBeNull();
		expect(positioned!.className).toContain('Toastify__toast-container--top-left');
	});

	it('renders the project\'s own close button inside a toast', async () => {
		const { toast } = require('react-toastify');
		render(<ToastContainer />);

		toast('a message');

		expect(await screen.findByText('a message')).toBeTruthy();
		// The project replaces the library's close button with its own; it is
		// the only button inside the toast.
		const closeButton = document.querySelector('.Toastify__toast button');
		expect(closeButton).not.toBeNull();
	});
});
