import type {
  UartComponent,
  UartComponentProperty,
  UartPermission,
} from '../../src/devices/dock/constants.js';

/**
 * Build a `UartComponentProperty` for a component/property pair that the real
 * `UART_PROP` table need not contain.
 *
 * The loopback tests script a dock's replies byte by byte, so they address
 * arbitrary component/property pairs on purpose — the point is to exercise
 * framing, CRC and resync, not the table. `UartComponentProperty.component` is
 * typed as {@link UartComponent}, a union of the bytes the table does list, so
 * a synthesised pair cannot satisfy it without a cast.
 *
 * That cast lives here, once, rather than at each call site: it is legitimate
 * for a test that deliberately goes outside the table, and misleading anywhere
 * else. Prefer a real `UART_PROP` entry when the test cares which property it
 * is talking to.
 */
export function uartArg(
  component: number,
  property: number,
  permission: UartPermission = 'READ_WRITE',
  name = 'x',
): UartComponentProperty {
  return { component: component as UartComponent, property, permission, name };
}
