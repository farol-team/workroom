class TheRoomsRecordJournal < ActiveRecord::Migration[8.1]
  # One row per thing that happened in a room, in the order it happened. The
  # payload lives in the object store, addressed by its digest; what this table
  # holds is the order and the chain — the part a bucket cannot keep.
  def change
    create_table :channel_records do |t|
      t.references :workspace, null: false, foreign_key: true
      # Plain, like every sibling's: the journal goes when the room goes, and
      # Channel#channel_records is what takes it — delete_all, because a row
      # nothing may update is a row nothing may destroy either. The keys here
      # guard integrity and refuse a room whose journal is still standing.
      t.references :channel, null: false, foreign_key: true
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

    # A child of one workspace cannot reference a parent of another — the same
    # composite key 20260801130001 gave every other table with a channel
    # parent. The boundary policy reads workspace_id without a join, so a row
    # where the two disagree would be readable from the wrong room.
    add_foreign_key :channel_records, :channels,
                    column: %i[channel_id workspace_id], primary_key: %i[id workspace_id]
  end
end
