export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          display_name: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          display_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          display_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      wallets: {
        Row: {
          id: string
          user_id: string
          currency: string
          balance: number // integer minor units (cents)
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          currency?: string
          balance?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          currency?: string
          balance?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      wallet_transactions: {
        Row: {
          id: string
          wallet_id: string
          user_id: string
          type: 'top_up' | 'live_session_charge' | 'refund' | 'adjustment'
          amount: number // integer cents (positive for credit, negative for debit)
          currency: string
          status: 'pending' | 'completed' | 'failed' | 'reversed'
          reference: string | null
          description: string | null
          created_at: string
        }
        Insert: {
          id?: string
          wallet_id: string
          user_id: string
          type: 'top_up' | 'live_session_charge' | 'refund' | 'adjustment'
          amount: number
          currency?: string
          status?: 'pending' | 'completed' | 'failed' | 'reversed'
          reference?: string | null
          description?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          wallet_id?: string
          user_id?: string
          type?: 'top_up' | 'live_session_charge' | 'refund' | 'adjustment'
          amount?: number
          currency?: string
          status?: 'pending' | 'completed' | 'failed' | 'reversed'
          reference?: string | null
          description?: string | null
          created_at?: string
        }
        Relationships: []
      }
      payment_records: {
        Row: {
          id: string
          user_id: string
          reference: string
          ngn_amount: number // minor units kobo
          usd_credit_amount: number // minor units cents
          exchange_rate_used: number
          status: 'initialized' | 'pending' | 'success' | 'failed' | 'abandoned'
          paystack_access_code: string | null
          authorization_url: string | null
          metadata: Json | null
          verified_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          reference: string
          ngn_amount: number
          usd_credit_amount: number
          exchange_rate_used: number
          status?: 'initialized' | 'pending' | 'success' | 'failed' | 'abandoned'
          paystack_access_code?: string | null
          authorization_url?: string | null
          metadata?: Json | null
          verified_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          reference?: string
          ngn_amount?: number
          usd_credit_amount?: number
          exchange_rate_used?: number
          status?: 'initialized' | 'pending' | 'success' | 'failed' | 'abandoned'
          paystack_access_code?: string | null
          authorization_url?: string | null
          metadata?: Json | null
          verified_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      live_sessions: {
        Row: {
          id: string
          user_id: string
          decart_session_id: string | null
          started_at: string
          ended_at: string | null
          duration_seconds: number
          billed_amount: number // cents
          status: 'active' | 'completed' | 'terminated_insufficient_funds' | 'abandoned' | 'failed'
          last_heartbeat_at: string
          last_billed_at: string
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          decart_session_id?: string | null
          started_at?: string
          ended_at?: string | null
          duration_seconds?: number
          billed_amount?: number
          status?: 'active' | 'completed' | 'terminated_insufficient_funds' | 'abandoned' | 'failed'
          last_heartbeat_at?: string
          last_billed_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          decart_session_id?: string | null
          started_at?: string
          ended_at?: string | null
          duration_seconds?: number
          billed_amount?: number
          status?: 'active' | 'completed' | 'terminated_insufficient_funds' | 'abandoned' | 'failed'
          last_heartbeat_at?: string
          last_billed_at?: string
          created_at?: string
        }
        Relationships: []
      }
      reconciliation_logs: {
        Row: {
          id: string
          job_name: string
          started_at: string
          completed_at: string | null
          sessions_reconciled: number
          status: 'running' | 'success' | 'failed'
          error_message: string | null
          duration_ms: number | null
          created_at: string
        }
        Insert: {
          id?: string
          job_name?: string
          started_at?: string
          completed_at?: string | null
          sessions_reconciled?: number
          status: 'running' | 'success' | 'failed'
          error_message?: string | null
          duration_ms?: number | null
          created_at?: string
        }
        Update: {
          id?: string
          job_name?: string
          started_at?: string
          completed_at?: string | null
          sessions_reconciled?: number
          status?: 'running' | 'success' | 'failed'
          error_message?: string | null
          duration_ms?: number | null
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      start_live_session: {
        Args: {
          p_user_id: string
          p_decart_session_id?: string
        }
        Returns: {
          session_id: string
          user_id: string
          status: string
          started_at: string
          current_balance: number
        }[]
      }
      heartbeat_and_meter_session: {
        Args: {
          p_session_id: string
          p_user_id: string
        }
        Returns: {
          session_id: string
          status: string
          cumulative_seconds: number
          billed_cents: number
          new_balance: number
          stop_requested: boolean
          reason: string
        }[]
      }
      end_live_session: {
        Args: {
          p_session_id: string
          p_user_id: string
        }
        Returns: {
          session_id: string
          status: string
          total_seconds: number
          total_billed_cents: number
          final_balance: number
        }[]
      }
      reconcile_stale_sessions: {
        Args: Record<string, never>
        Returns: number
      }
      credit_wallet: {
        Args: {
          p_user_id: string
          p_amount_cents: number
          p_type: string
          p_reference?: string
          p_description?: string
        }
        Returns: {
          wallet_id: string
          new_balance: number
          transaction_id: string
        }[]
      }
      debit_wallet: {
        Args: {
          p_user_id: string
          p_amount_cents: number
          p_type: string
          p_reference?: string
          p_description?: string
        }
        Returns: {
          wallet_id: string
          new_balance: number
          transaction_id: string
        }[]
      }
      credit_verified_payment: {
        Args: {
          p_reference: string
          p_gateway_status: string
          p_metadata?: Json
        }
        Returns: {
          success: boolean
          already_processed: boolean
          credited_amount_cents: number
          new_balance: number
          message: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export type Profile = Database['public']['Tables']['profiles']['Row']
export type ProfileInsert = Database['public']['Tables']['profiles']['Insert']
export type ProfileUpdate = Database['public']['Tables']['profiles']['Update']

export type Wallet = Database['public']['Tables']['wallets']['Row']
export type WalletTransaction = Database['public']['Tables']['wallet_transactions']['Row']
export type PaymentRecord = Database['public']['Tables']['payment_records']['Row']
export type LiveSession = Database['public']['Tables']['live_sessions']['Row']
export type ReconciliationLog = Database['public']['Tables']['reconciliation_logs']['Row']
