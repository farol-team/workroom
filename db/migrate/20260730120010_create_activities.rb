class CreateActivities < ActiveRecord::Migration[8.1]
  def change
    # Append-only. Аудит без превращения всей системы в event-sourced.
    create_table :activities do |t|
      t.references :actor,   null: false, polymorphic: true
      t.references :subject, null: true,  polymorphic: true
      t.string   :action,   null: false
      t.jsonb    :metadata, null: false, default: {}
      t.datetime :created_at, null: false
    end
    add_index :activities, :created_at
  end
end
