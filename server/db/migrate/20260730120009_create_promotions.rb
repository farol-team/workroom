class CreatePromotions < ActiveRecord::Migration[8.1]
  def change
    # Продвижение в общую память — явное действие, а не побочный эффект.
    # Дистилляция создаёт proposed; человек подтверждает; job применяет.
    create_table :promotions do |t|
      t.references :source,      null: false, polymorphic: true  # Message|AgentRun|Artifact
      t.references :channel,     null: false, foreign_key: true
      t.references :proposed_by, null: true,  foreign_key: { to_table: :users }
      t.references :approved_by, null: true,  foreign_key: { to_table: :users }

      t.string :state, null: false, default: "proposed"
      # proposed | approved | rejected | applied

      t.string :viking_uri           # заполняется после применения
      t.text   :rationale
      t.timestamps
    end
    add_index :promotions, [ :channel_id, :state ]
  end
end
