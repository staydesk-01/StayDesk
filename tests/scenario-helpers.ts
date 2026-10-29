export { __setProvidersForTest, getBookingProvider } from "../server/services/booking";
export { nativeBookingProvider as nativeBookingProviderForTest_ } from "../server/services/booking/nativeProvider";
import { nativeBookingProvider } from "../server/services/booking/nativeProvider";
export const nativeBookingProviderForTest = () => nativeBookingProvider;
