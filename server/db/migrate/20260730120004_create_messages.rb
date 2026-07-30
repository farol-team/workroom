class CreateMessages < ActiveRecord::Migration[8.1]
  def change
    create_table :messages do |t|
      t.references :channel, null: false, foreign_key: true

      # User | AgentRun. Ответ агента привязан к прогону, а не к человеку,
      # поэтому из сообщения можно провалиться в шаги и стоимость.
      t.references :author,  null: false, polymorphic: true

      # Треды на один уровень. Бесконечная вложенность — UX-ловушка.
      t.references :parent,  null: true, foreign_key: { to_table: :messages }

      t.text :body, null: false
      t.timestamps
    end
    add_index :messages, [ :channel_id, :created_at ]
  end
end
