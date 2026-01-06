import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function setupDatabase() {
  console.log('🔧 Setting up TableNow database...\n');

  try {
    // Note: These SQL commands should be run directly in Supabase SQL Editor
    // This script provides the SQL for reference

    const sql = `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Restaurants table
CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  owner_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  address TEXT,
  cuisine_type VARCHAR(100),
  capacity INTEGER DEFAULT 50,
  max_party_size INTEGER DEFAULT 10,
  advance_booking_days INTEGER DEFAULT 30,
  cancellation_policy TEXT,
  opening_hours JSONB,
  special_features TEXT,
  
  -- Knowledge Base / Documents
  faq_text TEXT,
  menu_url VARCHAR(500),
  faq_document_url VARCHAR(500),
  policies_url VARCHAR(500),
  
  -- VAPI integration
  vapi_phone_number VARCHAR(50),
  vapi_phone_id VARCHAR(255),
  vapi_assistant_id VARCHAR(255),
  
  -- Email integration
  bcc_email VARCHAR(255),
  
  -- Calendar integration
  google_calendar_tokens TEXT,
  
  -- Verification
  verification_token VARCHAR(255),
  is_verified BOOLEAN DEFAULT FALSE,
  
  -- Status
  status VARCHAR(50) DEFAULT 'pending',
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bookings table
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  
  -- Guest information
  guest_name VARCHAR(255) NOT NULL,
  guest_email VARCHAR(255),
  guest_phone VARCHAR(50),
  
  -- Booking details
  booking_date DATE NOT NULL,
  booking_time TIME NOT NULL,
  party_size INTEGER NOT NULL,
  special_requests TEXT,
  
  -- Status
  status VARCHAR(50) DEFAULT 'confirmed',
  confirmation_number VARCHAR(100) UNIQUE,
  
  -- Source tracking
  source VARCHAR(50) DEFAULT 'manual',
  
  -- External integrations
  calendar_event_id VARCHAR(255),
  hubspot_deal_id VARCHAR(255),
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Call logs table
CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  
  -- Call details
  call_id VARCHAR(255) UNIQUE,
  caller_number VARCHAR(50),
  duration INTEGER,
  status VARCHAR(50),
  
  -- Content
  transcript TEXT,
  recording_url TEXT,
  
  -- Timestamps
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- BCC emails table
CREATE TABLE IF NOT EXISTS bcc_emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  
  -- Email details
  from_email VARCHAR(255),
  subject TEXT,
  
  -- Parsed data
  parsed_type VARCHAR(50),
  parsed_source VARCHAR(50),
  guest_email VARCHAR(255),
  guest_phone VARCHAR(50),
  booking_date DATE,
  booking_time TIME,
  party_size INTEGER,
  
  -- Raw content
  raw_content TEXT,
  
  -- Timestamp
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_bookings_restaurant ON bookings(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_call_logs_restaurant ON call_logs(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_bcc_emails_restaurant ON bcc_emails(restaurant_id);

-- Enable Row Level Security
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bcc_emails ENABLE ROW LEVEL SECURITY;

-- RLS Policies for restaurants (users can only see their own data)
CREATE POLICY "Users can view own restaurant" ON restaurants
  FOR SELECT USING (auth.uid()::text = id::text);

CREATE POLICY "Users can update own restaurant" ON restaurants
  FOR UPDATE USING (auth.uid()::text = id::text);

-- RLS Policies for bookings
CREATE POLICY "Users can view own bookings" ON bookings
  FOR SELECT USING (restaurant_id::text = auth.uid()::text);

CREATE POLICY "Users can insert own bookings" ON bookings
  FOR INSERT WITH CHECK (restaurant_id::text = auth.uid()::text);

CREATE POLICY "Users can update own bookings" ON bookings
  FOR UPDATE USING (restaurant_id::text = auth.uid()::text);

CREATE POLICY "Users can delete own bookings" ON bookings
  FOR DELETE USING (restaurant_id::text = auth.uid()::text);

-- RLS Policies for call_logs
CREATE POLICY "Users can view own call logs" ON call_logs
  FOR SELECT USING (restaurant_id::text = auth.uid()::text);

-- RLS Policies for bcc_emails
CREATE POLICY "Users can view own bcc emails" ON bcc_emails
  FOR SELECT USING (restaurant_id::text = auth.uid()::text);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_restaurants_updated_at BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

    console.log('📋 SQL Schema:\n');
    console.log(sql);
    console.log('\n✅ Please run the above SQL in your Supabase SQL Editor\n');
    console.log('🔗 Go to: https://app.supabase.com/project/_/sql\n');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

setupDatabase();
