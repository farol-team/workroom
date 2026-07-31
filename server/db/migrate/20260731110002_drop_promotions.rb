class DropPromotions < ActiveRecord::Migration[8.1]
  # Article P3 amended: an agent writes to its channel's memory directly, and
  # correction supersedes. There is nothing left to approve.
  def change
    drop_table :promotions do |t|
      t.references :source,      null: false, polymorphic: true
      t.references :channel,     null: false, foreign_key: true
      t.references :proposed_by, null: true,  foreign_key: { to_table: :users }
      t.references :approved_by, null: true,  foreign_key: { to_table: :users }
      t.string :state, null: false, default: "proposed"
      t.string :viking_uri
      t.text   :rationale
      t.timestamps
    end
  end
end
