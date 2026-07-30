class CreateArtifacts < ActiveRecord::Migration[8.1]
  def change
    # Правило: результат работы уходит в канал, а не остаётся на ноутбуке.
    create_table :artifacts do |t|
      t.references :channel,   null: false, foreign_key: true
      t.references :agent_run, null: true,  foreign_key: true
      t.string :name, null: false
      t.string :kind
      t.timestamps
    end
  end
end
