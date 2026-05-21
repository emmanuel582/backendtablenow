/**
 * Central Type Exports
 * Import all types from this file for convenience
 */

// Booking Types
export * from './booking.types';

// VAPI Types
export * from './vapi.types';

// Restaurant Types
export * from './restaurant.types';

// Calendar Types
export * from './calendar.types';

// Re-export from schemas (for backward compatibility)
export {
    CreateBookingSchema,
    ManualCreateBookingSchema,
    UpdateBookingSchema,
    BookingQuerySchema,
    CheckAvailabilitySchema,
    VapiToolCallSchema,
    UUIDSchema,
    DateSchema,
    TimeSchema,
    PhoneSchema,
    LanguageSchema,
} from './schemas';

export type {
    CreateBookingInput,
    ManualCreateBookingInput,
    UpdateBookingInput,
    BookingQuery,
    CheckAvailabilityInput,
    Language,
    UpdateRestaurantLanguageInput,
} from './schemas';
