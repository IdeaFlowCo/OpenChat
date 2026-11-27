import { StackRouter } from '@react-navigation/routers';
import { expect, it } from 'vitest';

it('retains Main when onboarding is added after an asynchronous check (historical 1.0.6 race)', () => {
  const router = StackRouter({});
  const options = { routeNames: ['Main'], routeParamList: {}, routeGetIdList: {} };
  const first = router.getInitialState(options);
  const checked = router.getStateForRouteNamesChange(first, {
    ...options, routeNames: ['Onboarding', 'Main'], routeKeyChanges: [],
  });
  expect(checked.routes[checked.index].name).toBe('Main');
  // Waiting for the check before mounting the authenticated stack selects onboarding.
  const gated = router.getInitialState({ ...options, routeNames: ['Onboarding', 'Main'] });
  expect(gated.routes[gated.index].name).toBe('Onboarding');
});
