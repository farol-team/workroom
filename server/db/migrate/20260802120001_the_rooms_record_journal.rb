class TheRoomsRecordJournal < ActiveRecord::Migration[8.1]
  # One row per thing that happened in a room, in the order it happened. The
  # payload lives in the object store, addressed by its digest; what this table
  # holds is the order and the chain — the part a bucket cannot keep.
  def change
    create_table :channel_records do |t|
      t.references :workspace, null: false, foreign_key: true
      # The journal is a property of the room and goes when the room goes.
      # ON DELETE CASCADE rather than the model's callback: a row nothing may
      # update is a row nothing may destroy either.
      t.references :channel, null: false, foreign_key: { on_delete: :cascade }
      t.bigint :seq, null: false
      t.string :kind, null: false
      t.references :subject, polymorphic: true, null: true
      t.string :entry_hash, limit: 64, null: false
      t.string :prev_hash, limit: 64, null: false
      # No updated_at. There is nothing to update, and a column saying otherwise
      # is an invitation.
      t.datetime :created_at, null: false
    end

    # The lock in RecordStore::Append serializes writers; this is what catches
    # the case where it did not. Two entries claiming one place in the chain is
    # a fork, and a fork that reaches the table is one no reader can resolve.
    add_index :channel_records, %i[channel_id seq], unique: true
    add_index :channel_records, %i[channel_id entry_hash], unique: true
  end
end
